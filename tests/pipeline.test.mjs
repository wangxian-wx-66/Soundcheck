// P0-A 单元 + 集成测试（全部 mock，不烧知乎额度、不烧 LLM token）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, REPORTS_MAX, SEARCH_TTL_MS } from '../lib/db.mjs';
import { createGate } from '../lib/gate.mjs';
import { createZhihu, createMockZhihuFetch, normalizeQuestionUrl, searchCacheKey } from '../lib/zhihu.mjs';
import { createLlm, extractJson } from '../lib/llm.mjs';
import { createPipeline } from '../lib/pipeline.mjs';

function tempDir() { return mkdtempSync(path.join(tmpdir(), 'soundcheck-test-')); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, timeoutMs = 15_000, stepMs = 25) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return false;
}
function buildStack({ secret = 'test-secret', llmOptions = {}, script } = {}) {
  const db = openDb(tempDir());
  const gate = createGate({ activeLimit: 6, upstreamLimits: { zhihu: 4, llm: 4 } });
  const zhihu = createZhihu({ db, gate, secret, fetchImpl: createMockZhihuFetch() });
  const llm = createLlm({ mock: true, ...llmOptions });
  const pipeline = createPipeline({ db, zhihu, llm, gate });
  return { db, gate, zhihu, llm, pipeline };
}

// ---------- gate ----------
test('gate: 活跃上限与排队位置通知', async () => {
  const gate = createGate({ activeLimit: 3, upstreamLimits: { zhihu: 2 } });
  const releases = [];
  for (let i = 0; i < 3; i++) releases.push(await gate.acquire());
  assert.equal(gate.stats().running, 3);

  const positions = [];
  const fourth = gate.acquire((p) => positions.push(p));
  await sleep(20);
  assert.equal(gate.stats().queued, 1);
  assert.deepEqual(positions, [1]);

  releases[0]();
  const release4 = await fourth;
  assert.equal(gate.stats().running, 3);
  assert.equal(gate.stats().queued, 0);
  release4();
  releases.slice(1).forEach((r) => r());
  assert.equal(gate.stats().running, 0);
});

test('gate: 上游在飞上限', async () => {
  const gate = createGate({ activeLimit: 6, upstreamLimits: { zhihu: 2 } });
  let inflight = 0, maxInflight = 0;
  const task = async () => {
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    await sleep(40); inflight--;
  };
  await Promise.all(Array.from({ length: 6 }, () => gate.withUpstream('zhihu', task)));
  assert.equal(maxInflight, 2);
});

// ---------- db ----------
test('db: 报告落库与回访', () => {
  const db = openDb(tempDir());
  db.saveReport({ runId: 'r1', mode: 'review', question: '测试问题', result: { rating: 'A', coverage: {} } });
  const loaded = db.getReport('r1');
  assert.equal(loaded.mode, 'review');
  assert.equal(loaded.result.rating, 'A');
  assert.equal(db.getReport('nope'), null);
});

test('db: reports LRU 上限', () => {
  const db = openDb(tempDir());
  for (let i = 0; i < REPORTS_MAX + 5; i++) {
    db.saveReport({ runId: `run-${i}`, mode: 'radar', question: `q${i}`, result: { i } });
  }
  assert.equal(db.countReports(), REPORTS_MAX);
  assert.equal(db.getReport('run-0'), null); // 最旧的被淘汰
  assert.notEqual(db.getReport(`run-${REPORTS_MAX + 4}`), null);
});

test('db: 搜索缓存 TTL 过期（可控时钟）', () => {
  let clock = 1_000_000;
  const db = openDb(tempDir(), { now: () => clock });
  db.setSearchCache('zhihu_search', 'k1', { items: [1] });
  assert.deepEqual(db.getSearchCache('zhihu_search', 'k1').items, [1]);
  clock += SEARCH_TTL_MS.zhihu_search + 1;
  assert.equal(db.getSearchCache('zhihu_search', 'k1'), null);
  // qa_cache 7 天 TTL
  db.setQaCache('qk1', 'https://www.zhihu.com/question/1', { items: [] });
  clock += 8 * 24 * 3600_000;
  assert.equal(db.getQaCache('qk1'), null);
});

// ---------- zhihu ----------
test('zhihu: 问题 URL 规范化', () => {
  assert.equal(normalizeQuestionUrl('https://www.zhihu.com/question/20691338'), 'https://www.zhihu.com/question/20691338');
  assert.equal(normalizeQuestionUrl('看这个 https://www.zhihu.com/question/20691338/answer/53910077?utm=x'), 'https://www.zhihu.com/question/20691338');
  assert.equal(normalizeQuestionUrl('zhihu.com/question/123'), 'https://www.zhihu.com/question/123');
  assert.equal(normalizeQuestionUrl('https://zhuanlan.zhihu.com/p/123'), null);
  assert.equal(normalizeQuestionUrl(''), null);
});

test('zhihu: 缓存键区分 count 与接口（v2.4 修正回归）', () => {
  assert.notEqual(searchCacheKey('zhihu_search', { query: 'a', count: 5 }), searchCacheKey('zhihu_search', { query: 'a', count: 10 }));
  assert.notEqual(searchCacheKey('zhihu_search', { query: 'a', count: 10 }), searchCacheKey('global_search', { query: 'a', count: 10 }));
});

test('zhihu: 搜索→缓存命中（第二次不发请求）+ single-flight 合并并发', async () => {
  const db = openDb(tempDir());
  const gate = createGate();
  let fetchCount = 0;
  const countingFetch = async (url, ...rest) => {
    fetchCount++;
    return createMockZhihuFetch()(url, ...rest);
  };
  const zhihu = createZhihu({ db, gate, secret: 's', fetchImpl: countingFetch });

  // 并发同 key：single-flight 合并为 1 次请求（双方共享同一次在飞调用，均非缓存命中）
  const [a, b] = await Promise.all([zhihu.search('机器学习'), zhihu.search('机器学习')]);
  assert.equal(fetchCount, 1);
  assert.equal(a.items.length > 0, true);
  assert.equal(b.cached, false);

  // 顺序二次调用：缓存命中
  const c = await zhihu.search('机器学习');
  assert.equal(fetchCount, 1);
  assert.equal(c.cached, true);

  const qa = await zhihu.questionAnswers('https://www.zhihu.com/question/20691338');
  assert.equal(qa.items.length, 3);
  assert.equal(qa.items[0].rank, 1);
  assert.equal((await zhihu.questionAnswers('question/20691338')).cached, true);
  await assert.rejects(() => zhihu.questionAnswers('https://zhuanlan.zhihu.com/p/1'), { code: 'BAD_QUESTION_URL' });
});

test('zhihu: 30001 限流重试一次后成功', async () => {
  const db = openDb(tempDir());
  const gate = createGate();
  let calls = 0;
  const flakyFetch = async (url) => {
    calls++;
    if (calls === 1) return jsonResponse({ Code: 30001, Message: 'rate limit' });
    return createMockZhihuFetch()(url);
  };
  const zhihu = createZhihu({ db, gate, secret: 's', fetchImpl: flakyFetch, sleep: () => Promise.resolve() });
  const result = await zhihu.search('机器学习');
  assert.equal(calls, 2);
  assert.equal(result.items.length > 0, true);
});

// ---------- llm ----------
test('llm: extractJson 稳健解析', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('好的，以下是结果：{"a":1} 以上。'), { a: 1 });
  assert.equal(extractJson('不是 JSON'), null);
  assert.equal(extractJson(''), null);
});

// ---------- pipeline 端到端（mock LLM + mock 知乎） ----------
test('pipeline: review 模式全流程（检索→标杆→三段报告→落库→事件序）', async () => {
  const { db, zhihu, llm, pipeline } = buildStack();
  const { runId } = pipeline.start('review', {
    question: '机器学习该怎么入门？',
    draft: '我认为入门机器学习应该先学数学基础，然后做项目实践，最后选一门好课程。',
  });

  const ok = await waitFor(() => pipeline.getStatus(runId)?.status === 'done' || pipeline.getStatus(runId)?.status === 'failed');
  assert.equal(ok, true, '管线应在超时前完成');
  assert.equal(pipeline.getStatus(runId).status, 'done', '状态应为 done');

  const events = pipeline.getEvents(runId, 0);
  const types = events.map((e) => e.type);
  for (const required of ['parse', 'search_start', 'search_done', 'benchmark_start', 'benchmark_done', 'final_start', 'done']) {
    assert.ok(types.includes(required), `事件应包含 ${required}，实际：${types.join(',')}`);
  }
  // 事件序号严格递增
  for (let i = 1; i < events.length; i++) assert.ok(events[i].seq > events[i - 1].seq, 'seq 应严格递增');

  const { result } = pipeline.getReport(runId);
  assert.ok(['S', 'A', 'B', 'C'].includes(result.rating));
  assert.ok(result.coverage.argument_map.length >= 3);
  assert.ok(result.coverage.argument_map.length <= 4);
  assert.ok(result.increment.unique.length >= 1);
  assert.ok(result.controversy.objections.length >= 1);
  assert.equal(result.trace.tool_calls, 3); // mock 脚本：2 搜索 + 1 标杆
  assert.equal(result.trace.qa_benchmark_pulled, true);

  // 报告已落库：用同一 db 新建 pipeline 实例可回访（模拟进程重启）
  const pipeline2 = createPipeline({ db, zhihu, llm, gate: createGate() });
  const persisted = pipeline2.getReport(runId);
  assert.equal(persisted.runId, runId);
  assert.equal(persisted.result.rating, result.rating);
  // 草稿不落库：序列化后的报告不含草稿原文
  assert.equal(JSON.stringify(persisted).includes('我认为入门机器学习'), false);
});

test('pipeline: radar 模式（仅问题无草稿）', async () => {
  const { pipeline } = buildStack();
  const { runId } = pipeline.start('radar', { question: '机器学习该怎么入门？' });
  await waitFor(() => pipeline.getStatus(runId)?.status === 'done');
  const { result } = pipeline.getReport(runId);
  assert.equal(result.trace.mode, 'radar');
  assert.ok(result.coverage.argument_map.length >= 3);
});

test('pipeline: 标准步骤兜底——模型未调 question_answers 时代码级注入', async () => {
  // 脚本只有两次搜索、无标杆调用 → 兜底注入应补拉标杆序
  const script = [
    { tool: 'zhihu_search', args: { query: '机器学习 入门' } },
    { tool: 'zhihu_search', args: { query: '数学基础' } },
  ];
  const db = openDb(tempDir());
  const gate = createGate();
  const zhihu = createZhihu({ db, gate, secret: 's', fetchImpl: createMockZhihuFetch() });
  const llm = createLlm({ mock: true, mockScript: script });
  const pipeline = createPipeline({ db, zhihu, llm, gate });

  const { runId } = pipeline.start('radar', { question: '机器学习该怎么入门？' });
  await waitFor(() => pipeline.getStatus(runId)?.status === 'done');
  const { result } = pipeline.getReport(runId);
  assert.equal(result.trace.qa_benchmark_pulled, true, '兜底应拉取标杆序');
  assert.equal(result.trace.tool_calls, 3); // 2 搜索 + 1 注入
  const types = pipeline.getEvents(runId, 0).map((e) => e.type);
  assert.ok(types.includes('benchmark_start'));
});

test('pipeline: 参数校验', () => {
  const { pipeline } = buildStack();
  assert.throws(() => pipeline.start('review', { question: 'x' }), /草稿/);
  assert.throws(() => pipeline.start('bad', { question: 'x' }), /mode/);
  assert.throws(() => pipeline.start('radar', {}), /不能同时为空/);
});

test('pipeline: 知乎未配置时降级（无检索，直接推导报告）', async () => {
  const db = openDb(tempDir());
  const gate = createGate();
  const zhihu = createZhihu({ db, gate, secret: '', fetchImpl: createMockZhihuFetch() }); // secret 空 → 未配置
  const llm = createLlm({ mock: true });
  const pipeline = createPipeline({ db, zhihu, llm, gate });
  assert.equal(zhihu.configured, false);

  const { runId } = pipeline.start('review', {
    question: '机器学习该怎么入门？',
    draft: '先学数学，再学课程，最后做项目。',
  });
  await waitFor(() => pipeline.getStatus(runId)?.status === 'done');
  const { result } = pipeline.getReport(runId);
  assert.equal(result.trace.tool_calls, 0);
  assert.equal(result.trace.qa_benchmark_pulled, false);
});

test('pipeline: 工具预算 6 次封顶', async () => {
  const script = Array.from({ length: 8 }, (_, i) => ({ tool: 'zhihu_search', args: { query: `查询${i}` } }));
  const db = openDb(tempDir());
  const gate = createGate();
  const zhihu = createZhihu({ db, gate, secret: 's', fetchImpl: createMockZhihuFetch() });
  const llm = createLlm({ mock: true, mockScript: script });
  const pipeline = createPipeline({ db, zhihu, llm, gate });

  const { runId } = pipeline.start('radar', { question: '机器学习该怎么入门？' });
  await waitFor(() => pipeline.getStatus(runId)?.status === 'done');
  const { result } = pipeline.getReport(runId);
  assert.ok(result.trace.tool_calls <= 6, `工具调用不应超过 6，实际 ${result.trace.tool_calls}`);
});

test('pipeline: 失败事件（LLM 未配置且非 mock）', async () => {
  const db = openDb(tempDir());
  const gate = createGate();
  const zhihu = createZhihu({ db, gate, secret: '', fetchImpl: createMockZhihuFetch() });
  const llm = createLlm({ mock: false, apiKey: '' });
  const pipeline = createPipeline({ db, zhihu, llm, gate });

  const { runId } = pipeline.start('radar', { question: '机器学习该怎么入门？' });
  await waitFor(() => pipeline.getStatus(runId)?.status === 'failed');
  const failed = pipeline.getEvents(runId, 0).find((e) => e.type === 'failed');
  assert.equal(failed.data.code, 'LLM_NO_KEY');
});

function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload };
}
