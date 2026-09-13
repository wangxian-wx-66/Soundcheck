// LLM 层：DeepSeek（OpenAI 兼容）function calling + JSON mode + 一次重试 + 超时熔断
// 环境变量：DEEPSEEK_API_KEY / LLM_BASE_URL（默认 https://api.deepseek.com）/ LLM_MODEL（默认 deepseek-flash）
// LLM_MOCK=1 时使用内置脚本化响应（冒烟测试，不烧 token）
import { createLlmTimeoutError } from './errors.mjs';

export class LlmError extends Error {
  constructor(message, code = 'LLM_FAILED') { super(message); this.code = code; }
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** 从模型输出中稳健提取 JSON（容忍 ```json 围栏 / 前后缀文本） */
export function extractJson(text) {
  if (!text) return null;
  const direct = tryParse(text.trim());
  if (direct !== undefined) return direct;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced && tryParse(fenced[1].trim()) !== undefined) return tryParse(fenced[1].trim());
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const sliced = tryParse(text.slice(start, end + 1));
    if (sliced !== undefined) return sliced;
  }
  return null;
}

function tryParse(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

export function createLlm(options = {}) {
  const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY ?? '';
  const baseUrl = (options.baseUrl ?? process.env.LLM_BASE_URL ?? 'https://api.deepseek.com').replace(/\/$/, '');
  const model = options.model ?? process.env.LLM_MODEL ?? 'deepseek-flash';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const http = options.fetchImpl ?? fetch;
  const mock = options.mock ?? process.env.LLM_MOCK === '1';

  async function realChat({ messages, tools, jsonMode = false, signal }) {
    if (!apiKey) throw new LlmError('DEEPSEEK_API_KEY 未配置（LLM 大脑不可用）', 'LLM_NO_KEY');
    const body = { model, messages, stream: false };
    if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }
    if (jsonMode) body.response_format = { type: 'json_object' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await http(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new LlmError(`DeepSeek HTTP ${response.status}: ${text.slice(0, 200)}`, 'LLM_HTTP_ERROR');
      }
      const payload = await response.json();
      const choice = payload?.choices?.[0];
      if (!choice?.message) throw new LlmError('DeepSeek 返回结构异常（无 choices）', 'LLM_BAD_RESPONSE');
      return choice.message;
    } catch (error) {
      if (error.name === 'AbortError' || signal?.aborted) throw createLlmTimeoutError();
      if (error instanceof LlmError) throw error;
      throw new LlmError(error.message, 'LLM_NETWORK');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  const chat = mock ? mockChat(options.mockScript) : realChat;

  /**
   * 强制 JSON 输出：response_format + 稳健解析 + 解析失败重问一次
   * 返回解析后的对象；两次都失败抛 LlmError
   */
  async function chatJson({ messages, signal, retryHint = '' }) {
    let lastText = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const message = await chat({
        messages: attempt === 0 ? messages : [...messages, { role: 'user', content: `${retryHint}请只输出合法 JSON，不要包含任何其他文字或代码围栏。` }],
        jsonMode: true,
        signal,
      });
      lastText = message.content || '';
      const parsed = extractJson(lastText);
      if (parsed && typeof parsed === 'object') return { parsed, message };
    }
    throw new LlmError(`模型两次未能输出合法 JSON：${lastText.slice(0, 120)}`, 'LLM_JSON_PARSE');
  }

  return {
    chat,
    chatJson,
    get model() { return model; },
    get mock() { return mock; },
    get configured() { return mock || Boolean(apiKey); },
  };
}

/** mock 脚本：工具轮按顺序吐 function call，最终轮吐报告 JSON；解析调用按提示词内容识别
 *  多 run 并发安全：每个新对话（尚无 assistant 消息的首轮工具调用）重置脚本——否则 10 路压测共享一份 steps，
 *  只有第 1 路走完整管线，其余 9 路零工具调用直接收尾 */
function mockChat(script) {
  const source = script || defaultMockScript();
  let steps = [...source];
  return async ({ messages, tools, jsonMode }) => {
    const lastUser = [...(messages || [])].reverse().find((m) => m.role === 'user')?.content || '';
    // 解析调用（chatJson 且提示词含「提炼」）
    if (jsonMode && /提炼/.test(lastUser)) {
      const isRadar = /子议题/.test(lastUser);
      return { role: 'assistant', content: JSON.stringify(isRadar
        ? { title_guess: '机器学习该怎么入门？（mock）', sub_topics: ['数学基础准备', '课程与教材选择', '实践项目路径'], search_queries: ['机器学习 入门', '机器学习 数学基础'] }
        : { title_guess: '机器学习该怎么入门？（mock）', arguments: ['数学基础先行', '项目驱动学习', '课程与教材组合'], search_queries: ['机器学习 入门', '机器学习 数学基础'] }) };
    }
    // 杠精 Agent 调用（chatJson 且提示词含「找茬」）
    if (jsonMode && /找茬/.test(lastUser)) {
      return { role: 'assistant', content: JSON.stringify(mockCynic()) };
    }
    // 工具轮：新对话首轮（无 assistant 消息）重置脚本
    if (tools?.length) {
      if (!(messages || []).some((m) => m.role === 'assistant')) steps = [...source];
      if (steps.length) {
        const step = steps.shift();
        if (step.tool) {
          return { role: 'assistant', content: '', tool_calls: [{ id: `call_${Date.now()}_${steps.length}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args || {}) } }] };
        }
      }
    }
    // 最终报告（含 chatJson 重问轮）；额度降级时按系统提示声明（quota 降级测试锚点）
    const finalContent = typeof steps[0]?.content === 'string' ? steps.shift().content : JSON.stringify(mockReport(messages));
    return { role: 'assistant', content: finalContent };
  };
}

function defaultMockScript() {
  return [
    { tool: 'zhihu_search', args: { query: '机器学习 入门', count: 10 } },
    { tool: 'question_answers', args: { question_url: 'https://www.zhihu.com/question/20691338' } },
    { tool: 'zhihu_search', args: { query: '数学基础 机器学习', count: 10 } },
    { content: null }, // 最终报告
  ];
}

function mockCynic() {
  return {
    nitpicks: [
      { objection: '「补数学基础」是正确的废话——线性代数/概率论谁不知道要学？', why: '评论区对没有给出学习顺序与深度的泛泛而谈零容忍', evidence: 'real', source: '数学基础真的重要，别跳过' },
      { objection: '第三步「做项目实战」——项目从哪来？回避了转行者最卡的入口问题。', why: '转行路线不给项目来源等于没回答', evidence: 'inferred', source: '基于论点推导的潜在质疑' },
      { objection: '通篇无个人经历，像 AI 生成的通稿。', why: '社区对 AI 味内容高度敏感，第一人称经验是信任前提', evidence: 'inferred', source: '基于论点推导的潜在质疑' },
    ],
    own_rating: 'C',
    disagreements: [
      { point: '增量评级', chief: 'B：课程+教材组合路径算少量独有增量', cynic: 'C：标杆序 #3 就是课程组合推荐，算不上独有' },
      { point: '严谨度', chief: '草稿路线完整、逻辑自洽', cynic: '无数据无引用无个人验证，撑不起「严谨」' },
    ],
  };
}

function mockReport(messages) {
  const report = {
    question_title: '机器学习该怎么入门？（mock）',
    rating: 'B',
    coverage: {
      benchmarks: [
        { rank: 1, title: 'CS229 数学推导路线', url: 'https://www.zhihu.com/answer/53910077', key_points: ['监督学习数学推导', '先理论后实践'], evidence_level: 'L1' },
        { rank: 2, title: '边做项目边补数学', url: 'https://www.zhihu.com/answer/22465357', key_points: ['项目驱动', '数学按需补'], evidence_level: 'L1' },
      ],
      recent: [
        { title: '机器学习入门路线（mock）', url: 'https://zhuanlan.zhihu.com/p/1001', votes: 88, authority: 'L4', key_points: ['数学三大支柱'], evidence_level: 'L2' },
      ],
      argument_map: [
        { argument: '先补数学基础再入门', status: 'covered', evidence_level: 'L1', source_urls: ['https://www.zhihu.com/answer/53910077'] },
        { argument: '项目驱动边做边学', status: 'covered', evidence_level: 'L1', source_urls: ['https://www.zhihu.com/answer/22465357'] },
        { argument: '课程+教材组合路径', status: 'unique', evidence_level: 'L2', source_urls: ['https://www.zhihu.com/answer/30001111'] },
        { argument: '入门阶段的常见误区', status: 'blank', evidence_level: '推导', source_urls: [] },
      ],
    },
    increment: {
      covered: ['先补数学基础再入门', '项目驱动边做边学'],
      unique: ['课程+教材组合路径'],
      blanks: ['入门阶段的常见误区'],
      amplify: '建议强化第 3 条论点，补充具体学习周期与资源清单。',
    },
    controversy: {
      objections: [
        { objection: '数学基础不用先学全', response: '承认按需补的合理性，强调最小集合', evidence: 'real', source: '数学基础真的重要，别跳过' },
        { objection: '路线过于学院派，脱离工业界需求', response: '补充工程实践证据', evidence: 'inferred', source: '基于论点推导的潜在质疑' },
      ],
    },
    radar: { novelty: 6, rigor: 7, experience: 5, resonance: 6 },
    meta: { confidence: 'medium', note: '判断基于检索摘要（非全文），附原文链接可对照。' },
  };
  // 额度降级时按系统提示声明（quota 降级测试锚点）
  if (messages?.some((m) => m.role === 'system' && m.content.includes('额度降级'))) {
    report.meta.note = `搜索额度低余量，L2 补强已跳过。${report.meta.note}`;
  }
  return report;
}
