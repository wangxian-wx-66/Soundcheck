import http from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOAuth } from './lib/oauth.mjs';
import { openDb } from './lib/db.mjs';
import { createGate } from './lib/gate.mjs';
import { createZhihu, createMockZhihuFetch, ZhihuApiError } from './lib/zhihu.mjs';
import { createLlm } from './lib/llm.mjs';
import { createPipeline } from './lib/pipeline.mjs';
import { createOpportunity } from './lib/opportunity.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(path.join(root, 'hackathon.config.json'), 'utf8'));
const publicDir = path.join(root, 'public');

// .env 本地加载（零依赖）：仅填补未设置的变量，真实环境变量优先（Sealos Secret 注入不受影响）
// .env 已被 .gitignore 排除；文件不存在时静默跳过
if (process.env.SMOKE !== '1') {
  const envFile = path.join(root, '.env');
  if (existsSync(envFile)) {
    for (const line of (await readFile(envFile, 'utf8')).split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || line.trim().startsWith('#')) continue;
      const [, key, raw] = match;
      const value = raw.replace(/^["']|["']$/g, '');
      if (process.env[key] === undefined && value !== '') process.env[key] = value;
    }
  }
}

const oauth = createOAuth(config);
const runtimeHost = process.env.HOST || (process.env.PORT ? '0.0.0.0' : config.host);
const runtimePort = Number(process.env.PORT || config.port);
const types = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.ico', 'image/x-icon'],
]);

// 主管线装配：数据层 → 知乎适配层 → LLM → 并发闸门 → Agent 管线
const db = openDb(process.env.DATA_DIR || path.join(root, 'data'));
const gate = createGate({ activeLimit: 6, upstreamLimits: { zhihu: 4, llm: 4 } });
const zhihu = createZhihu({
  db,
  gate,
  secret: process.env.SMOKE === '1' ? 'smoke-mock-secret' : (process.env.ZHIHU_ACCESS_SECRET || ''),
  fetchImpl: process.env.SMOKE === '1' ? createMockZhihuFetch() : undefined,
});
const llm = createLlm();

// 启动自检 quota（不消耗额度）：zhihu_search 余量 <20% → 降级标志（跳过 L2 补强，省额度保险丝）
// 查询失败/未配置/SMOKE 模式不降级——降级必须是可核实的判断，不是猜测
let quotaLow = false;
let quotaNote = '';
if (zhihu.configured && process.env.SMOKE !== '1') {
  try {
    const quotas = await zhihu.quota(['zhihu_search']);
    const q = Array.isArray(quotas) && quotas.find((item) => item.APIID === 'zhihu_search');
    if (q && Number(q.TotalQuota) > 0 && Number(q.RemainingQuota) / Number(q.TotalQuota) < 0.2) {
      quotaLow = true;
      quotaNote = `搜索余量 ${q.RemainingQuota}/${q.TotalQuota}`;
    }
  } catch { /* quota 查询失败不降级，也不阻塞启动 */ }
}
if (quotaLow) process.stdout.write(`[quota] 搜索额度低余量（${quotaNote}），本次运行将跳过 L2 定向补强\n`);

const pipeline = createPipeline({ db, zhihu, llm, gate, quotaLow });
const opportunity = createOpportunity({ zhihu, db });

// 机会榜后台预计算（P2）：启动 5s 后跑一次 + 每 12h 刷新（每日 ≤2 次预计算，hot_list+search 额度富余）
// 失败静默（下次 interval 重试；请求侧还有现算兜底）；SMOKE 模式跳过后台（mock 由请求驱动）
if (zhihu.configured && process.env.SMOKE !== '1') {
  const prewarmOpportunity = () => opportunity
    .get()
    .then((result) => process.stdout.write(`[opportunity] 预计算完成：${result.items.length} 个机会 · gap ${result.items.map((i) => i.gap).join('/')}\n`))
    .catch(() => { /* 预计算失败不阻塞，请求时兜底现算 */ });
  setTimeout(prewarmOpportunity, 5_000).unref?.();
  setInterval(prewarmOpportunity, 12 * 3600_000).unref?.();
}

function headers(type = 'application/json; charset=utf-8') {
  return {
    'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  };
}
function json(response, status, payload) { response.writeHead(status, headers()); response.end(JSON.stringify(payload)); }
function redirect(response, location) { response.writeHead(302, { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); response.end(); }
/** 登录回访地址 + oauth 结果参数拼接（正确处理 #hash，避免参数落进 hash 段） */
function appendOauthParam(pathname, value) {
  const target = new URL(pathname, 'http://local');
  target.searchParams.set('oauth', value);
  return target.pathname + target.search + target.hash;
}

async function readJsonBody(request, limitBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limitBytes) throw Object.assign(new Error('请求体过大'), { code: 'PAYLOAD_TOO_LARGE' });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('请求体不是合法 JSON'), { code: 'BAD_JSON' }); }
}

/** SSE：事件自增序号 + Last-Event-ID 续传 + 15s 心跳（反代不掐长连接）
 *  重启后回放：事件已落 SQLite events 表——报告在则回放至 done；事件在但报告缺（任务被重启打断）则补 failed 事件，绝不静默挂死 */
function handleRunEvents(request, response, runId) {
  const backlog = pipeline.getEvents(runId, 0);
  const status = pipeline.getStatus(runId);
  if (!backlog.length && !status) return json(response, 404, { ok: false, error: { code: 'RUN_NOT_FOUND', message: '任务不存在或已过期（服务器可能重启过）' } });

  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const write = (chunk) => response.write(chunk);
  const sendEvent = (event) => write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

  const lastEventId = Number(request.headers['last-event-id'] || 0);
  for (const event of backlog) if (event.seq > lastEventId) sendEvent(event);

  const heartbeat = setInterval(() => write(': ping\n\n'), 15_000);
  const unsubscribe = pipeline.subscribe(runId, sendEvent);
  if (status && (status.status === 'done' || status.status === 'failed') && !backlog.length) sendEvent({ seq: 0, ts: Date.now(), type: status.status, data: {} });
  // 重启场景：事件回放到一半但既无 done/failed 也无活跃 run → 任务被重启打断，诚实告知（前端据此显示重试）
  if (!pipeline.getRun(runId) && !['done', 'failed'].includes(backlog[backlog.length - 1]?.type)) {
    sendEvent({ seq: (backlog[backlog.length - 1]?.seq || 0) + 1, ts: Date.now(), type: 'failed', data: { code: 'SERVER_RESTARTED', message: '服务器重启，任务已中断。请返回重新发起分析' } });
  }

  request.on('close', () => { clearInterval(heartbeat); unsubscribe?.(); });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${config.host}:${config.port}`);
  try {
    // ---- OAuth（官方脚手架路由；start/callback 扩展了回访地址传递） ----
    if (request.method === 'GET' && url.pathname === '/api/health') {
      return json(response, 200, { ok: true, project: config.projectName, oauthEnabled: true, llm: llm.configured ? (llm.mock ? 'mock' : llm.model) : 'missing_key', zhihu: zhihu.configured ? 'ready' : 'missing_secret', quotaLow });
    }
    if (request.method === 'GET' && url.pathname === '/api/oauth/status') return json(response, 200, { ok: true, ...(await oauth.status(request, response)) });
    if (request.method === 'GET' && url.pathname === '/api/oauth/start') {
      try { return redirect(response, await oauth.start(request, response, url.searchParams.get('from'))); }
      catch (error) { oauth.record(request, response, error); return redirect(response, '/?oauth=error'); }
    }
    if (request.method === 'GET' && url.pathname === '/auth/callback') {
      try {
        const back = await oauth.callback(request, response, url);
        return redirect(response, appendOauthParam(back || '/', 'success'));
      } catch (error) { oauth.record(request, response, error); return redirect(response, '/?oauth=error'); }
    }
    if (request.method === 'POST' && url.pathname === '/api/oauth/run-all') return json(response, 200, { ok: true, results: await oauth.runAll(request, response) });
    if (request.method === 'POST' && url.pathname === '/api/oauth/logout') { oauth.logout(request, response); return json(response, 200, { ok: true }); }

    // ---- 个人历史（P0-B：登录解锁——计登录数不拦人；不登录时主功能全部可用） ----
    if (request.method === 'GET' && url.pathname === '/api/user/contents') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 10, 1), 50);
      const result = await oauth.contents(request, response, { limit });
      return json(response, 200, { ok: true, ...result });
    }

    // ---- 主管线（P0-A） ----
    if (request.method === 'POST' && url.pathname === '/api/analyze') {
      const body = await readJsonBody(request);
      const { runId } = pipeline.start(body.mode, {
        question: body.question || '',
        draft: body.draft || '',
        questionUrl: body.question_url || '',
      });
      return json(response, 200, { ok: true, runId });
    }
    const runMatch = url.pathname.match(/^\/api\/run\/([0-9a-f-]+)\/events$/);
    if (request.method === 'GET' && runMatch) return handleRunEvents(request, response, runMatch[1]);
    const statusMatch = url.pathname.match(/^\/api\/run\/([0-9a-f-]+)\/status$/);
    if (request.method === 'GET' && statusMatch) {
      const status = pipeline.getStatus(statusMatch[1]);
      if (!status) return json(response, 404, { ok: false, error: { code: 'RUN_NOT_FOUND', message: '任务不存在' } });
      return json(response, 200, { ok: true, ...status });
    }
    const reportMatch = url.pathname.match(/^\/api\/report\/([0-9a-f-]+)$/);
    if (request.method === 'GET' && reportMatch) {
      const report = pipeline.getReport(reportMatch[1]);
      if (!report) return json(response, 404, { ok: false, error: { code: 'REPORT_NOT_FOUND', message: '报告不存在（分析可能仍在进行或已失败）' } });
      return json(response, 200, { ok: true, ...report });
    }
    if (request.method === 'GET' && url.pathname === '/api/hot') {
      if (!zhihu.configured) return json(response, 503, { ok: false, error: { code: 'ZHIHU_NOT_CONFIGURED', message: 'ZHIHU_ACCESS_SECRET 未配置' } });
      const hot = await zhihu.hotList(10);
      return json(response, 200, { ok: true, items: hot.items, cached: Boolean(hot.cached) });
    }
    // 机会榜（P2）：热榜上还缺好回答的问题——每日缓存，未命中时现算（≤8 次搜索，约 6s）
    if (request.method === 'GET' && url.pathname === '/api/opportunities') {
      if (!zhihu.configured) return json(response, 503, { ok: false, error: { code: 'ZHIHU_NOT_CONFIGURED', message: 'ZHIHU_ACCESS_SECRET 未配置' } });
      const result = await opportunity.get();
      return json(response, 200, { ok: true, ...result });
    }
    if (request.method === 'GET' && url.pathname === '/api/stats') {
      const mem = process.memoryUsage();
      return json(response, 200, {
        ok: true, ...pipeline.stats(),
        memory: { rss_mb: Math.round(mem.rss / 1048576), heap_used_mb: Math.round(mem.heapUsed / 1048576), heap_total_mb: Math.round(mem.heapTotal / 1048576) },
        zhihu_calls: zhihu.callLog, // 上游真实调用计数（缓存命中不计）——压测 single-flight 验证用
      });
    }

    // ---- 静态页面 ----
    if (request.method !== 'GET') return json(response, 405, { ok: false, error: { message: '不支持的请求方法' } });
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = path.join(publicDir, path.normalize(requested));
    if (!filePath.startsWith(publicDir) || !existsSync(filePath)) return json(response, 404, { ok: false, error: { message: '页面不存在' } });
    response.writeHead(200, headers(types.get(path.extname(filePath)) || 'application/octet-stream'));
    response.end(await readFile(filePath));
  } catch (error) {
    if (error instanceof ZhihuApiError) return json(response, 502, { ok: false, error: { code: error.code, message: error.message } });
    const authError = error.code === 'LOGIN_REQUIRED' || error.code === 'TOKEN_EXPIRED'; // 个人历史未登录/过期 → 401（前端静默降级，不拦功能）
    const clientError = error.code === 'BAD_JSON' || error.code === 'PAYLOAD_TOO_LARGE' || error.code === 'BAD_REQUEST';
    json(response, authError ? 401 : clientError ? 400 : 500, { ok: false, error: { code: error.code || 'REQUEST_FAILED', message: error.message } });
  }
});

server.listen(runtimePort, runtimeHost, () => process.stdout.write(`${config.projectName}: http://${runtimeHost}:${runtimePort}/\n`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
