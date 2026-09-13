// Agent 管线（主管线，run_id 贯穿全链路）：
//   pending → running → done/failed 状态机；SSE 事件自增序号；工具预算 6 次；
//   单轮 LLM 60s / 全管线 5min 双熔断；question_answers 标准步骤代码级兜底注入；
//   三段 JSON 落 reports 表（不含草稿原文——隐私承诺：后端与数据库不落草稿）
import { randomUUID } from 'node:crypto';
import { PipelineTimeoutError } from './errors.mjs';
import { normalizeQuestionUrl } from './zhihu.mjs';

function badRequest(message) {
  return Object.assign(new Error(message), { code: 'BAD_REQUEST' });
}

export const TOOL_BUDGET = 6;
export const PIPELINE_TIMEOUT_MS = 5 * 60_000;
export const QUEUE_TIMEOUT_MS = 10 * 60_000;
const MEMORY_RETENTION_MS = 10 * 60_000;
const MAX_MEMORY_RUNS = 50;

const SYSTEM_PROMPT = `你是「试麦员 Soundcheck」的主审 Agent——一名严谨的知乎内容研究官。你在答主发布内容之前，检索知乎站内已有回答与讨论，产出三段式分析报告。

检索纪律（必须遵守）：
1. 你最多有 ${TOOL_BUDGET} 次工具调用预算。检索词优先使用问题的核心实体 + 论点关键词，不要用整句话搜索。
2. 【标准步骤·非可选】一旦搜索结果中出现目标问题的 URL（zhihu.com/question/ 数字），必须调用 question_answers 拉取该问题的默认排序前 20 条回答——这是社区标杆序，是覆盖分析的第一证据层。
3. 【标准步骤·L2 定向补强】从标杆回答摘要中提取 1-2 个论点关键词，再用 zhihu_search 检索验证该论点的社区覆盖深度（预留 2 次搜索预算）。
4. 证据不足时可改写检索词再搜；证据充分（已有标杆序 + 近期讨论 + 至少一次论点深度验证）即停止检索，直接输出最终报告。

证据等级（每个判断必须标注其一）：
- L1：question_answers 标杆序位次（社区共识排序）
- L2：zhihu_search 富字段（赞数/权威等级/摘要）
- L3：CommentInfoList 真实评论
- 推导：仅基于论点逻辑推导，无检索证据

诚实纪律：
- 你的判断只能基于接口返回的摘要（不是全文），meta.note 中必须声明这一点。
- 搜索结果偏近期讨论，不等于高赞标杆；标杆以 question_answers 默认序为准。
- 不伪造赞数、作者、评论。CommentInfoList 缺失时，相关质疑的 evidence 标为 "inferred"。

最终报告只输出一个 JSON 对象（不要输出任何其他文字），结构如下：
{
  "question_title": "问题标题",
  "rating": "S | A | B | C",
  "coverage": {
    "benchmarks": [{"rank": 1, "title": "标杆回答标识", "url": "原文链接", "key_points": ["论点"], "evidence_level": "L1"}],
    "recent": [{"title": "近期讨论标识", "url": "原文链接", "votes": 0, "authority": "L3", "key_points": ["论点"], "evidence_level": "L2"}],
    "argument_map": [{"argument": "论点一句话", "status": "covered|unique|blank", "evidence_level": "L1", "source_urls": ["支撑链接"]}]
  },
  "increment": {
    "covered": ["已被已有回答覆盖的论点"],
    "unique": ["真正独有增量（radar 模式为：该问题尚缺的好回答方向）"],
    "blanks": ["相邻空白论点"],
    "amplify": "如何放大增量的具体可执行建议"
  },
  "controversy": {
    "objections": [{"objection": "评论区最可能出现的反驳", "response": "应对建议", "evidence": "real|inferred", "source": "真实评论内容或推导依据"}]
  },
  "radar": {"novelty": 0, "rigor": 0, "experience": 0, "resonance": 0},
  "meta": {"confidence": "high|medium|low", "note": "证据边界说明"}
}
要求：argument_map 给 3-4 个论点；rating 取 S=显著独有增量 / A=有明确增量 / B=少量增量 / C=基本被覆盖；radar 四维 0-10 整数（experience/resonance 为启发式估计，note 中注明）；所有 url 使用检索结果中的原文链接。`;

const MODE_PROMPT = {
  review: '当前为「开麦评审」模式：用户已写出草稿。任务 = 对比草稿论点与已有回答，找出真正增量与空白，并预演评论区反驳。',
  radar: '当前为「选题雷达」模式：用户只有问题、没有草稿。任务 = 梳理该问题的论点版图（已被覆盖的方向），并指出尚缺好回答的空白方向。increment.unique 应写「该问题还缺的好回答角度」，controversy 预演的是未来答主最可能被杠的点。',
};

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'zhihu_search',
      description: '知乎站内搜索。返回与关键词相关的问题/回答/文章，含摘要、赞数、权威等级、精选评论。检索词用关键词组合，不要用完整句子。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索关键词，如「机器学习 数学基础」' },
          count: { type: 'number', description: '返回条数 1-10，默认 10' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'question_answers',
      description: '获取指定知乎问题下的回答列表（社区默认排序≈标杆序，前 20 条，含薄摘要）。必须在搜索结果中出现目标问题 URL 后调用。',
      parameters: {
        type: 'object',
        properties: { question_url: { type: 'string', description: '完整的知乎问题 URL' } },
        required: ['question_url'],
      },
    },
  },
];

export function createPipeline({ db, zhihu, llm, gate, now = Date.now } = {}) {
  const runs = new Map();

  function getRun(runId) { return runs.get(runId) || null; }

  function emit(run, type, data = {}) {
    const event = { seq: ++run.seq, ts: now(), type, data };
    run.events.push(event);
    if (run.events.length > 400) run.events.splice(0, run.events.length - 400);
    for (const subscriber of run.subscribers) {
      try { subscriber(event); } catch { /* 订阅方异常不影响管线 */ }
    }
  }

  function forgetLater(runId) {
    setTimeout(() => runs.delete(runId), MEMORY_RETENTION_MS).unref?.();
  }

  /** 启动一次分析（异步执行，立即返回 run_id；SSE 通过 subscribe/getEvents 消费） */
  function start(mode, { question = '', draft = '', questionUrl = '' } = {}) {
    if (mode !== 'review' && mode !== 'radar') throw badRequest('mode 必须是 review 或 radar');
    if (mode === 'review' && !String(draft).trim()) throw badRequest('开麦评审模式必须提供草稿');
    if (!String(question).trim() && !String(draft).trim()) throw badRequest('问题与草稿不能同时为空');

    const run = {
      runId: randomUUID(), mode, question: String(question).trim().slice(0, 300),
      draft: String(draft).slice(0, 20_000), // 仅内存，绝不落库
      status: 'pending', seq: 0, events: [], subscribers: new Set(),
      startedAt: now(), toolCallsUsed: 0, qaCalled: false, questionUrlHit: normalizeQuestionUrl(questionUrl || question) || null,
      report: null,
    };
    runs.set(run.runId, run);
    trimMemoryRuns();

    execute(run).catch(() => { /* execute 内部已兜底 */ });
    return { runId: run.runId, queuePosition: gate.stats().queued + 1 };
  }

  function trimMemoryRuns() {
    if (runs.size <= MAX_MEMORY_RUNS) return;
    const finished = [...runs.values()].filter((r) => r.status === 'done' || r.status === 'failed');
    finished.sort((a, b) => a.startedAt - b.startedAt);
    for (const run of finished.slice(0, runs.size - MAX_MEMORY_RUNS)) runs.delete(run.runId);
  }

  async function execute(run) {
    let release;
    try {
      release = await gate.acquire((position) => {
        if (run.status === 'pending') emit(run, 'queued', { position });
      });
      if (now() - run.startedAt > QUEUE_TIMEOUT_MS) throw new PipelineTimeoutError('排队超时');
      run.status = 'running';
      emit(run, 'start', { mode: run.mode, question: run.question, run_id: run.runId });

      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), PIPELINE_TIMEOUT_MS);
      try {
        const report = await analyze(run, controller.signal);
        run.status = 'done';
        run.report = report;
        // 落库（不含草稿）
        db.saveReport({ runId: run.runId, mode: run.mode, question: report.question_title || run.question, result: report });
        emit(run, 'done', { rating: report.rating, tool_calls: run.toolCallsUsed, elapsed_ms: now() - run.startedAt });
        forgetLater(run.runId);
      } finally {
        clearTimeout(deadline);
      }
    } catch (error) {
      run.status = 'failed';
      emit(run, 'failed', { code: error.code || 'PIPELINE_FAILED', message: String(error.message || error).slice(0, 300) });
      forgetLater(run.runId);
    } finally {
      release?.();
    }
  }

  /** 主审 Agent 分析全流程 */
  async function analyze(run, signal) {
    const zhihuReady = zhihu.configured;
    // ① 解析：草稿→论点 / 问题→子议题（独立结构化调用，产出 parse 事件）
    emit(run, 'budget', { used: 0, total: TOOL_BUDGET });
    const parse = await parseInput(run, signal);
    emit(run, 'parse', parse);

    // ② Agent 检索循环
    const degradedNote = zhihuReady ? '' : `\n\n【降级】知乎检索接口未配置（缺 ZHIHU_ACCESS_SECRET），跳过所有工具调用，直接基于论点推导输出报告，并在 meta.note 声明「无检索证据」。`;
    const messages = [
      { role: 'system', content: `${SYSTEM_PROMPT}\n\n${MODE_PROMPT[run.mode]}${degradedNote}` },
      { role: 'user', content: buildUserMessage(run, parse) },
    ];
    const evidence = { chips: [], questionUrls: new Set() };
    let finalMessage = null;

    while (true) {
      if (signal.aborted) throw new PipelineTimeoutError();
      const message = await gate.withUpstream('llm', () => llm.chat({ messages, tools: zhihuReady ? TOOLS : undefined, signal }));
      messages.push(message);

      if (message.tool_calls?.length) {
        for (const call of message.tool_calls) {
          const result = await executeTool(run, call, evidence, signal);
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
          emit(run, 'budget', { used: run.toolCallsUsed, total: TOOL_BUDGET });
        }
        continue;
      }

      // 无工具调用 = 尝试收尾；标准步骤兜底：已发现目标问题但未拉标杆序 → 代码级注入
      if (zhihuReady && !run.qaCalled && run.questionUrlHit && run.toolCallsUsed < TOOL_BUDGET) {
        const injected = await injectStandardStep(run, messages, evidence, signal);
        if (injected) continue;
      }
      finalMessage = message;
      break;
    }

    // ③ 三段 JSON（解析失败重问一次）
    emit(run, 'final_start', {});
    let report = parseReportJson(finalMessage?.content || '');
    if (!report) {
      const { parsed } = await gate.withUpstream('llm', () => llm.chatJson({
        messages: [...messages, { role: 'user', content: '请按系统指令输出最终三段式报告 JSON。' }],
        signal,
      }));
      report = parsed;
    }
    return normalizeReport(report, run);
  }

  async function parseInput(run, signal) {
    const prompt = run.mode === 'review'
      ? `从以下草稿中提炼 3-5 个核心论点（每条一句话），猜测它想回答的问题标题，并给出 2-3 个用于检索知乎已有回答的搜索词（关键词组合）。\n\n草稿：\n${run.draft}`
      : `针对以下知乎问题，提炼 3-5 个子议题（每条一句话），并给出 2-3 个用于检索该问题已有讨论的搜索词（关键词组合）。\n\n问题：${run.question}`;
    const { parsed } = await gate.withUpstream('llm', () => llm.chatJson({
      messages: [{ role: 'user', content: `${prompt}\n\n输出 JSON：{"title_guess": "...", "${run.mode === 'review' ? 'arguments' : 'sub_topics'}": ["..."], "search_queries": ["..."]}` }],
      signal,
    }));
    const list = parsed.arguments || parsed.sub_topics || [];
    return {
      title_guess: String(parsed.title_guess || run.question || '').slice(0, 200),
      arguments: list.map(String).slice(0, 6),
      search_queries: (parsed.search_queries || []).map(String).slice(0, 4),
    };
  }

  function buildUserMessage(run, parse) {
    const head = run.mode === 'review' ? `【草稿原文】\n${run.draft}\n` : `【目标问题】${run.question}\n`;
    return `${head}
【解析结果】
问题标题（猜测）：${parse.title_guess}
${run.mode === 'review' ? '草稿核心论点' : '问题子议题'}：
${parse.arguments.map((a, i) => `${i + 1}. ${a}`).join('\n')}
建议首发检索词：${parse.search_queries.join(' / ') || '（自行决定）'}

${run.questionUrlHit ? `【目标问题 URL】${run.questionUrlHit}\n` : ''}请按系统指令执行检索与分析${
    run.mode === 'review' ? '，对比草稿论点与已有回答，输出三段式报告。' : '，梳理论点版图与空白方向，输出三段式报告。'}`;
  }

  async function executeTool(run, call, evidence, signal) {
    if (run.toolCallsUsed >= TOOL_BUDGET) {
      return { error: '工具预算已用尽，请直接输出最终报告' };
    }
    let name = call.function?.name;
    let args = {};
    try { args = JSON.parse(call.function?.arguments || '{}'); } catch { return { error: '参数不是合法 JSON' }; }
    if (!zhihu.configured) return { error: '检索接口未配置' };
    if (signal.aborted) throw new PipelineTimeoutError();

    try {
      if (name === 'zhihu_search' || name === 'global_search') {
        const query = String(args.query || '').slice(0, 100);
        if (!query) return { error: 'query 不能为空' };
        run.toolCallsUsed++;
        const round = run.toolCallsUsed;
        emit(run, 'search_start', { query, count: args.count || 10, round });
        const result = name === 'zhihu_search'
          ? await zhihu.search(query, { count: Math.min(Number(args.count) || 10, 10) })
          : await zhihu.globalSearch(query, { count: Math.min(Number(args.count) || 10, 20), filter: args.filter });
        collectEvidence(evidence, result.items);
        run.questionUrlHit = run.questionUrlHit || pickQuestionUrl(evidence);
        emit(run, 'search_done', { query, adopted: result.items.length, cached: Boolean(result.cached), round });
        emit(run, 'evidence', { chips: evidence.chips.slice(-6) });
        return { query, count: result.items.length, items: result.items };
      }
      if (name === 'question_answers') {
        const url = normalizeQuestionUrl(args.question_url);
        if (!url) return { error: 'question_url 无法识别，需要 https://www.zhihu.com/question/数字 格式' };
        run.toolCallsUsed++;
        emit(run, 'benchmark_start', { question_url: url });
        const result = await zhihu.questionAnswers(url, { limit: 20 });
        run.qaCalled = true;
        run.questionUrlHit = run.questionUrlHit || url;
        const chips = result.items.slice(0, 6).map((item) => ({ type: 'benchmark', label: `社区序 #${item.rank} · ${String(item.summary || '').slice(0, 30)}…` }));
        emit(run, 'benchmark_done', { count: result.items.length, cached: Boolean(result.cached) });
        emit(run, 'evidence', { chips });
        return { question_url: url, count: result.items.length, items: result.items };
      }
      return { error: `未知工具 ${name}` };
    } catch (error) {
      if (error.code === 'RATE_LIMIT') return { error: '知乎接口限流，请稍后重试或换检索词' };
      if (error.code === 'AUTH_FAILED') return { error: '知乎凭证无效（服务端配置问题）' };
      return { error: `工具执行失败：${String(error.message || error).slice(0, 150)}` };
    }
  }

  /** 标准步骤兜底：Agent 未调用 question_answers 时，harness 直接注入证据再让模型收尾 */
  async function injectStandardStep(run, messages, evidence, signal) {
    try {
      emit(run, 'benchmark_start', { question_url: run.questionUrlHit, injected: true });
      const result = await zhihu.questionAnswers(run.questionUrlHit, { limit: 20 });
      run.qaCalled = true;
      run.toolCallsUsed++;
      emit(run, 'benchmark_done', { count: result.items.length, cached: Boolean(result.cached), injected: true });
      emit(run, 'budget', { used: run.toolCallsUsed, total: TOOL_BUDGET });
      messages.push({ role: 'user', content: `【标准步骤·系统自动执行】已拉取目标问题（${run.questionUrlHit}）的标杆序前 ${result.items.length} 条回答：\n${JSON.stringify(result.items)}\n请结合以上证据输出最终三段式报告 JSON。` });
      return true;
    } catch {
      return false; // 拉取失败不阻断，让模型基于已有证据收尾
    }
  }

  function collectEvidence(evidence, items) {
    for (const item of items.slice(0, 5)) {
      evidence.chips.push({
        type: 'search',
        label: `${item.votes} 赞 · ${item.authority ? `L${item.authority} 权威` : '权威未知'} · ${String(item.author || '').slice(0, 12)}`,
      });
    }
    for (const item of items) {
      const url = normalizeQuestionUrl(item.url);
      if (url) evidence.questionUrls.add(url);
    }
  }

  function pickQuestionUrl(evidence) {
    // 优先选择与解析标题相关性最高的不可行（无向量），取第一个出现的问题 URL
    return evidence.questionUrls.values().next().value || null;
  }

  function parseReportJson(text) {
    try {
      const parsed = JSON.parse(String(text).trim());
      return parsed && typeof parsed === 'object' && parsed.coverage ? parsed : null;
    } catch { return null; }
  }

  function normalizeReport(report, run) {
    const rating = ['S', 'A', 'B', 'C'].includes(report?.rating) ? report.rating : 'B';
    const radar = {
      novelty: clampScore(report?.radar?.novelty),
      rigor: clampScore(report?.radar?.rigor),
      experience: clampScore(report?.radar?.experience),
      resonance: clampScore(report?.radar?.resonance),
    };
    return {
      question_title: String(report?.question_title || run.question || parseSafeTitle(run)).slice(0, 200),
      rating,
      coverage: {
        benchmarks: array(report?.coverage?.benchmarks).slice(0, 8),
        recent: array(report?.coverage?.recent).slice(0, 10),
        argument_map: array(report?.coverage?.argument_map).slice(0, 6).map((slot) => ({
          argument: String(slot.argument || '').slice(0, 120),
          status: ['covered', 'unique', 'blank'].includes(slot.status) ? slot.status : 'covered',
          evidence_level: String(slot.evidence_level || '推导').slice(0, 8),
          source_urls: array(slot.source_urls).slice(0, 4),
        })),
      },
      increment: {
        covered: array(report?.increment?.covered).slice(0, 8).map(String),
        unique: array(report?.increment?.unique).slice(0, 8).map(String),
        blanks: array(report?.increment?.blanks).slice(0, 8).map(String),
        amplify: String(report?.increment?.amplify || '').slice(0, 600),
      },
      controversy: {
        objections: array(report?.controversy?.objections).slice(0, 5).map((o) => ({
          objection: String(o.objection || '').slice(0, 200),
          response: String(o.response || '').slice(0, 300),
          evidence: o.evidence === 'real' ? 'real' : 'inferred',
          source: String(o.source || '').slice(0, 200),
        })),
      },
      radar,
      meta: {
        confidence: ['high', 'medium', 'low'].includes(report?.meta?.confidence) ? report.meta.confidence : 'medium',
        note: String(report?.meta?.note || '判断基于检索摘要（非全文），请点击原文链接对照。').slice(0, 300),
      },
      trace: {
        mode: run.mode,
        tool_calls: run.toolCallsUsed,
        qa_benchmark_pulled: run.qaCalled,
        rating,
        generated_at: new Date(now()).toISOString(),
      },
    };
  }

  function parseSafeTitle(run) {
    return run.mode === 'review' ? '（未命名草稿）' : run.question;
  }

  return {
    start,
    getRun,
    getEvents(runId, afterSeq = 0) {
      const run = runs.get(runId);
      if (!run) return null;
      return run.events.filter((event) => event.seq > afterSeq);
    },
    getStatus(runId) {
      const run = runs.get(runId);
      if (!run) return null;
      return { runId, status: run.status, mode: run.mode, seq: run.seq };
    },
    getReport(runId) {
      const run = runs.get(runId);
      if (run?.report) return { runId, mode: run.mode, question: run.question, result: run.report, createdAt: run.startedAt };
      return db.getReport(runId);
    },
    subscribe(runId, subscriber) {
      const run = runs.get(runId);
      if (!run) return null;
      run.subscribers.add(subscriber);
      return () => run.subscribers.delete(subscriber);
    },
    stats() {
      return { memory_runs: runs.size, gate: gate.stats() };
    },
  };
}

function array(value) { return Array.isArray(value) ? value : []; }
function clampScore(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.max(0, Math.min(10, Math.round(num))) : 5;
}
