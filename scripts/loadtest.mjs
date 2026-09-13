// 10 并发压测（P0-C / G2 门禁硬性验收项）：
// 验证 ① 并发闸门排队（活跃 ≤6，第 7-10 路收到「前方 N 人」queued 事件）
//      ② single-flight / 缓存合并同题（10 路只含 2 个唯一检索词 → 上游真实调用 ≤2 次）
//      ③ 无超时崩溃（全部 done，无 failed）
//      ④ 内存水位（--max-old-space-size=768 下 RSS 余量充足，1G 容器安全线）
// 用法：npm run loadtest（SMOKE=1 + LLM_MOCK=1，零额度零 token 消耗）
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = 4198;
const baseUrl = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// 10 路：6 个不同问题 + 4 路重复同题（同题走 single-flight/缓存，不应重复烧上游）
const QUESTIONS = [
  '机器学习该怎么入门？', '如何系统学习数据结构？', '转行做程序员来得及吗？',
  '研究生应该怎么规划三年？', '如何提高英语阅读能力？', '刚工作如何快速成长？',
  '机器学习该怎么入门？', '机器学习该怎么入门？', '转行做程序员来得及吗？', '如何提高英语阅读能力？',
];
const DRAFT = '我认为应该先打基础再实践：第一步补理论，第二步跟课程，第三步做项目。';

let child = null;
let dataDir = null;
const startedAt = Date.now();
try {
  dataDir = mkdtempSync(path.join(tmpdir(), 'soundcheck-load-'));
  child = spawn(process.execPath, ['--max-old-space-size=768', 'server.mjs'], {
    cwd: projectRoot,
    // MOCK_LATENCY_MS=300：模拟真实检索延迟量级，让闸门排队在 mock 链路下可被触发验证
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SMOKE: '1', LLM_MOCK: '1', MOCK_LATENCY_MS: '300', DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await sleep(500);
    try { ready = (await fetch(`${baseUrl}/api/health`)).ok; } catch { /* 等待启动 */ }
  }
  if (!ready) throw new Error('服务 30s 内未启动');

  // 同时发起 10 路（模拟评委高峰点击）
  const t0 = Date.now();
  const starts = await Promise.all(QUESTIONS.map((question) =>
    api('/api/analyze', { method: 'POST', body: JSON.stringify({ mode: 'review', question, draft: DRAFT }) })));
  const runIds = starts.map((s) => s.payload.runId);
  record('10 路同时发起 → 全部拿到 runId', starts.every((s) => s.status === 200 && s.payload.ok) && runIds.every(Boolean), `${runIds.length} 个 run`);

  // 轮询至全部终态
  const finished = new Map(); // runId → status
  const queueSeen = new Map(); // runId → 最大排队位置
  for (let round = 0; round < 600; round++) {
    await Promise.all(runIds.map(async (runId) => {
      if (finished.get(runId)) return;
      const status = await api(`/api/run/${runId}/status`);
      if (status.payload.status === 'done' || status.payload.status === 'failed') finished.set(runId, status.payload.status);
    }));
    if (finished.size === runIds.length) break;
    if (Date.now() - t0 > 120_000) break;
  }
  const doneCount = [...finished.values()].filter((s) => s === 'done').length;
  const failedCount = [...finished.values()].filter((s) => s === 'failed').length;
  const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);
  record('全部完成无失败（10/10 done，无超时崩溃）', doneCount === 10 && failedCount === 0, `done=${doneCount} failed=${failedCount} 耗时 ${elapsedS}s`);

  // ① 闸门排队验证：第 7-10 路应有 queued 事件（活跃上限 6）。已完成 run 的事件已落库，
  //    SSE 读取到 done/failed 即断开（3s 兜底超时）
  const eventTexts = await Promise.all(runIds.map(async (runId) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(`${baseUrl}/api/run/${runId}/events`, { signal: controller.signal, headers: { Accept: 'text/event-stream' } });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while (!text.includes('event: done') && !text.includes('event: failed')) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      controller.abort();
      return text;
    } catch { return ''; }
    finally { clearTimeout(timer); }
  }));
  let queuedRuns = 0;
  let maxPosition = 0;
  for (const text of eventTexts) {
    const positions = [...text.matchAll(/event: queued\ndata: .*?"position":(\d+)/g)].map((m) => Number(m[1]));
    if (positions.length) {
      queuedRuns++;
      maxPosition = Math.max(maxPosition, ...positions);
    }
  }
  // 诊断：首个 run 的 start→done 事件跨度（应 ≥ 900ms，即 3 次检索 × 300ms 延迟）
  {
    const startEv = eventTexts[0].match(/event: start\ndata: ([^\n]+)/);
    const doneEv = eventTexts[0].match(/event: done\ndata: ([^\n]+)/);
    if (startEv && doneEv) {
      const t1 = JSON.parse(startEv[1]).ts, t2 = JSON.parse(doneEv[1]).ts;
      process.stdout.write(`[diag] run[0] start→done = ${t2 - t1}ms\n`);
    }
  }
  record('并发闸门排队（≥4 路收到「前方 N 人」，位置≥1）', queuedRuns >= 4 && maxPosition >= 1, `排队 ${queuedRuns} 路 · 最大位置 ${maxPosition}`);

  // ② single-flight / 缓存合并：mock LLM 脚本固定 2 个检索词 + 1 个标杆 URL
  //    10 路共享 → 上游真实 zhihu_search 调用应 ≤2 次、question_answers ≤1 次
  const stats = await api('/api/stats');
  const calls = stats.payload.zhihu_calls || {};
  record('single-flight 合并同题（上游真实调用不随并发放大）',
    Number(calls.zhihu_search) <= 2 && Number(calls.question_answers) <= 1,
    `zhihu_search=${calls.zhihu_search}（10 路仅 2 个唯一词） question_answers=${calls.question_answers}`);

  // ④ 内存水位（--max-old-space-size=768 下）
  const mem = stats.payload.memory || {};
  record('内存水位（RSS < 512MB，1G 容器余量充足）', Number(mem.rss_mb) < 512, `rss=${mem.rss_mb}MB heap=${mem.heap_used_mb}/${mem.heap_total_mb}MB`);

  // 终态闸门复位
  record('闸门复位（running=0 queued=0）', stats.payload.gate?.running === 0 && stats.payload.gate?.queued === 0, JSON.stringify(stats.payload.gate || {}));

  // 报告回访抽检（事件与报告同级落库）
  const report = await api(`/api/report/${runIds[0]}`);
  record('压测后报告可回访', report.status === 200 && report.payload.ok === true, `rating=${report.payload.result?.rating}`);
} catch (error) {
  record('压测执行', false, String(error.message || error));
} finally {
  if (child) child.kill();
  if (dataDir) { for (const suffix of ['', '-wal', '-shm']) { try { rmSync(dataDir + suffix, { force: true, recursive: true }); } catch { /* 忽略 */ } } }
}

const failed = results.filter((r) => !r.ok).length;
process.stdout.write(`\n10 并发压测结果：${results.length - failed}/${results.length} 通过 · 总耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`);
process.exit(failed ? 1 : 0);
