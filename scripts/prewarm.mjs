// 演示问题全链路预热（P2）：3 个固定演示问题跑完整管线，搜索缓存 + 报告全部落库
// ——评委自助体验秒出、路演 Demo 稳定。命中缓存与实时链路走同一代码路径（只是不等检索）。
// 用法：
//   node scripts/prewarm.mjs --mock           # 本地 mock 链路验证（SMOKE=1 + LLM_MOCK=1，零额度）
//   node scripts/prewarm.mjs                  # 预热本地真 key 服务（默认 http://127.0.0.1:4173）
//   node scripts/prewarm.mjs --url https://xxx.sealos.run  # 预热已部署实例（部署后每次重部署跑一遍）
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const mockMode = args.has('--mock');
const externalUrl = mockMode ? null : (args.get('--url')?.replace(/\/$/, '') || 'http://127.0.0.1:4173');
const port = Number(args.get('--port') || 4198);

// 3 个固定演示问题（radar 模式：零门槛入口；评委点选题雷达即秒出缓存结果）
const DEMO_QUESTIONS = [
  '机器学习该怎么入门？',
  'AI 时代还需要学编程吗？',
  '普通人的第一桶金怎么积累？',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  return { status: response.status, payload: await response.json().catch(() => ({})) };
}

let baseUrl = externalUrl;
let child = null;
let dataDir = null;
const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` · ${detail}` : ''}\n`);
}

async function warmOnce(label) {
  // 第一遍：全链路（真实检索 + LLM，报告落库）
  for (const question of DEMO_QUESTIONS) {
    const start = Date.now();
    const res = await api('/api/analyze', { method: 'POST', body: JSON.stringify({ mode: 'radar', question }) });
    if (res.status !== 200 || !res.payload.ok) { record(`${label}：发起 ${question}`, false, JSON.stringify(res.payload.error || {})); continue; }
    const runId = res.payload.runId;
    let done = false;
    for (let i = 0; i < 120 && !done; i++) {
      await sleep(1000);
      const status = await api(`/api/run/${runId}/status`);
      if (status.payload.status === 'done') done = true;
      if (status.payload.status === 'failed') break;
    }
    const report = await api(`/api/report/${runId}`);
    const rating = report.payload.result?.rating;
    record(`${label}：${question}`, done && Boolean(rating), `rating=${rating} · ${((Date.now() - start) / 1000).toFixed(1)}s · run=${runId.slice(0, 8)}`);
  }
}

try {
  if (mockMode) {
    dataDir = mkdtempSync(path.join(tmpdir(), 'soundcheck-prewarm-'));
    child = spawn(process.execPath, ['server.mjs'], {
      cwd: projectRoot,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SMOKE: '1', LLM_MOCK: '1', DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
    baseUrl = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      await sleep(500);
      try { ready = (await fetch(`${baseUrl}/api/health`)).ok; } catch { /* 等待启动 */ }
    }
    if (!ready) throw new Error('mock 服务 30s 内未启动');
  }

  await warmOnce('第一遍（全链路，检索 + 报告落库）');

  // 第二遍：验证缓存命中——上游调用计数不再增长 = 评委再来秒出且不烧额度
  const statsBefore = await api('/api/stats');
  const callsBefore = mockMode ? statsBefore.payload.zhihu_calls : null;
  const secondStart = Date.now();
  await warmOnce('第二遍（缓存命中验证）');
  if (mockMode) {
    const statsAfter = await api('/api/stats');
    const grew = Object.entries(statsAfter.payload.zhihu_calls || {}).some(([k, v]) => (callsBefore?.[k] ?? 0) < v);
    record('缓存命中（第二遍上游调用零增长）', !grew, `上游调用 ${JSON.stringify(statsAfter.payload.zhihu_calls)} · 二遍总耗时 ${((Date.now() - secondStart) / 1000).toFixed(1)}s`);
  }
} catch (error) {
  record('预热执行', false, String(error.message || error));
} finally {
  if (child) child.kill();
  if (dataDir) { for (const suffix of ['', '-wal', '-shm']) { try { rmSync(dataDir + suffix, { force: true, recursive: true }); } catch { /* 忽略 */ } } }
}

const failed = results.filter((r) => !r.ok).length;
process.stdout.write(`\n预热结果：${results.length - failed}/${results.length} 通过\n`);
process.exit(failed ? 1 : 0);
