// HTTP 级烟测（G1 门禁自检 + Sealos 部署后复用）：
// SMOKE=1（mock 知乎）+ LLM_MOCK=1（mock DeepSeek），零额度消耗，30 秒跑完
// 用法：npm run smoke；线上部署后：SMOKE=1 LLM_MOCK=1 node scripts/smoke.mjs --url https://xxx.sealos.run
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const externalUrl = args.get('--url'); // 指定则测试已部署实例（不再本地起服务）
const port = Number(args.get('--port') || 4199);
const baseUrl = externalUrl?.replace(/\/$/, '') || `http://127.0.0.1:${port}`;

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` · ${detail}` : ''}\n`);
}
async function api(pathname, options = {}) {
  const response = await fetch(baseUrl + pathname, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child = null;
let dataDir = null;
try {
  if (!externalUrl) {
    dataDir = mkdtempSync(path.join(tmpdir(), 'soundcheck-smoke-'));
    child = spawn(process.execPath, ['server.mjs'], {
      cwd: projectRoot,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SMOKE: '1', LLM_MOCK: '1', DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      await sleep(500);
      try { ready = (await fetch(`${baseUrl}/api/health`)).ok; } catch { /* 等待启动 */ }
    }
    if (!ready) throw new Error('服务 30s 内未启动');
  }

  // 1. 健康检查
  const health = await api('/api/health');
  record('GET /api/health', health.status === 200 && health.payload.ok === true, `llm=${health.payload.llm} zhihu=${health.payload.zhihu}`);

  // 2. 参数校验 → 400
  const bad = await api('/api/analyze', { method: 'POST', body: JSON.stringify({ mode: 'review', question: 'x' }) });
  record('POST /api/analyze 参数校验（缺草稿 → 400）', bad.status === 400, bad.payload.error?.message || '');

  // 3. review 模式全流程
  const start = await api('/api/analyze', {
    method: 'POST',
    body: JSON.stringify({
      mode: 'review',
      question: '机器学习该怎么入门？',
      draft: '入门机器学习：第一步补数学基础（线性代数/概率论），第二步跟体系化课程，第三步做项目实战。误区：一上来就调参。',
    }),
  });
  const runId = start.payload.runId;
  record('POST /api/analyze（review）→ runId', start.status === 200 && Boolean(runId), runId);

  let done = false;
  for (let i = 0; i < 60 && !done; i++) {
    await sleep(500);
    const status = await api(`/api/run/${runId}/status`);
    if (status.payload.status === 'done') done = true;
    if (status.payload.status === 'failed') break;
  }
  record('管线执行完成（≤30s，mock 链路）', done === true);

  // 4. SSE 事件回放（自增序号 + done 事件）
  if (done) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    let sseText = '';
    try {
      const sse = await fetch(`${baseUrl}/api/run/${runId}/events`, { signal: controller.signal, headers: { 'Accept': 'text/event-stream' } });
      const reader = sse.body.getReader();
      const decoder = new TextDecoder();
      while (!sseText.includes('event: done')) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        sseText += decoder.decode(value, { stream: true });
        if (sseText.includes('event: done')) controller.abort();
      }
    } catch { /* abort 触发，正常 */ }
    clearTimeout(timer);
    record('SSE 事件流（含 id 序号、done 与杠精事件）', sseText.includes('event: done') && /id: \d+/.test(sseText) && sseText.includes('event: cynic_done'));
  }

  // 5. 报告回访（三段结构 + 评级 + 证据角标）
  const report = await api(`/api/report/${runId}`);
  const r = report.payload.result || {};
  const structureOk = report.status === 200 &&
    ['S', 'A', 'B', 'C'].includes(r.rating) &&
    Array.isArray(r.coverage?.argument_map) && r.coverage.argument_map.length >= 3 &&
    Array.isArray(r.increment?.unique) &&
    Array.isArray(r.controversy?.objections) &&
    Boolean(r.meta?.note);
  record('GET /api/report/:runId（三段 JSON + 评级 + 证据角标）', structureOk === true, `rating=${r.rating} tool_calls=${r.trace?.tool_calls} cynic=${r.cynic ? `${r.cynic.nitpicks?.length}条找茬` : '无'}`);

  // 6. 热榜入口
  const hot = await api('/api/hot');
  record('GET /api/hot（选题雷达数据源）', hot.status === 200 && Array.isArray(hot.payload.items) && hot.payload.items.length > 0);

  // 6.2 机会榜（P2）：热榜上还缺好回答的问题——mock 链路现算 + 每日缓存
  const opp = await api('/api/opportunities');
  const oppOk = opp.status === 200 && Array.isArray(opp.payload.items) && opp.payload.items.length > 0 &&
    opp.payload.items[0].gap >= 0 && Boolean(opp.payload.items[0].reason);
  record('GET /api/opportunities（机会榜：gap 评分 + 理由）', oppOk === true, `items=${opp.payload.items?.length} gap=${opp.payload.items?.[0]?.gap}`);
  const oppAgain = await api('/api/opportunities');
  record('GET /api/opportunities 二次命中缓存', oppAgain.status === 200 && oppAgain.payload.cached === true);

  // 6.5 个人历史（P0-B 登录解锁）：未登录 → 401 LOGIN_REQUIRED（不拦人：主功能全部可用）
  const mine = await api('/api/user/contents?limit=10');
  record('GET /api/user/contents（未登录 → 401，登录解锁）', mine.status === 401 && mine.payload.error?.code === 'LOGIN_REQUIRED', mine.payload.error?.code || '');

  // 7. 运行时状态
  const stats = await api('/api/stats');
  record('GET /api/stats（闸门/内存运行数）', stats.status === 200 && stats.payload.ok === true, JSON.stringify(stats.payload.gate || {}).slice(0, 80));

  // 8. 重启回放（G2 核心验收：events 落 SQLite，?run= 链接重启后依然能回放过程）——仅本地模式可测
  if (!externalUrl) {
    child.kill();
    await new Promise((resolve) => { child.on('exit', resolve); setTimeout(resolve, 2000); });
    child = spawn(process.execPath, ['server.mjs'], {
      cwd: projectRoot,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SMOKE: '1', LLM_MOCK: '1', DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
    let revived = false;
    for (let i = 0; i < 40 && !revived; i++) {
      await sleep(500);
      try { revived = (await fetch(`${baseUrl}/api/health`)).ok; } catch { /* 等待启动 */ }
    }
    if (!revived) throw new Error('重启后服务 20s 内未启动');

    const statusAfter = await api(`/api/run/${runId}/status`);
    const replay = await fetch(`${baseUrl}/api/run/${runId}/events`, { headers: { Accept: 'text/event-stream' } });
    const controller2 = new AbortController();
    const timer2 = setTimeout(() => controller2.abort(), 5000);
    let replayText = '';
    try {
      const reader = replay.body.getReader();
      const decoder = new TextDecoder();
      while (!replayText.includes('event: done')) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        replayText += decoder.decode(value, { stream: true });
        if (replayText.includes('event: done')) controller2.abort();
      }
    } catch { /* abort 触发，正常 */ }
    clearTimeout(timer2);
    const replayOk = statusAfter.payload.status === 'done' &&
      replay.status === 200 &&
      replayText.includes('event: parse') && replayText.includes('event: done') && replayText.includes('event: cynic_done');
    record('重启后 ?run= 回放（events 落 SQLite，状态与杠精事件完整）', replayOk === true, `事件 ${replayText.split('id: ').length - 1} 条`);

    // 重启后报告依旧可回访（reports 与 events 同级可靠）
    const reportAfter = await api(`/api/report/${runId}`);
    record('重启后报告回访（?report= 分享链接存活）', reportAfter.status === 200 && reportAfter.payload.result?.rating === r.rating, `rating=${reportAfter.payload.result?.rating}`);

    // 未知 run → 404（不伪造回放）
    const ghost = await api(`/api/run/00000000-0000-0000-0000-000000000000/events`);
    record('未知 run → 404（不伪造回放）', ghost.status === 404);
  }
} catch (error) {
  record('烟测执行', false, String(error.message || error));
} finally {
  if (child) child.kill();
  if (dataDir) { for (const suffix of ['', '-wal', '-shm']) { try { rmSync(dataDir + suffix, { force: true, recursive: true }); } catch { /* 忽略 */ } } }
}

const failed = results.filter((r) => !r.ok).length;
process.stdout.write(`\n烟测结果：${results.length - failed}/${results.length} 通过\n`);
process.exit(failed ? 1 : 0);
