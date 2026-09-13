// 知乎开放平台 HTTP 适配层：zhihu_search / global_search / question_answers / hot_list / quota
// Bearer + 秒级时间戳；30001 限流重试一次；缓存键 sha256(api_type+query+count+filter+sort+api_version)；
// single-flight：Map<cacheKey, Promise> 合并同 key 并发；上游在飞上限经 gate.withUpstream('zhihu')
import { createHash } from 'node:crypto';

const BASE = 'https://developer.zhihu.com/api/v1';
const API_VERSION = 'v1';

export class ZhihuApiError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}
export class RateLimitError extends ZhihuApiError {
  constructor(message = '触发频率限制') { super(message, 'RATE_LIMIT'); }
}
export class ZhihuAuthError extends ZhihuApiError {
  constructor(message = 'Access Secret 无效或未配置') { super(message, 'AUTH_FAILED'); }
}

/** 完整缓存键：仅 query 哈希会跨条件错误命中（不同 count/filter 共享到错误证据） */
export function searchCacheKey(apiType, { query, count, filter, sort } = {}) {
  return createHash('sha256')
    .update(JSON.stringify({ apiType, query, count, filter, sort, apiVersion: API_VERSION }))
    .digest('hex');
}

/** 从任意文本中提取并规范化知乎问题 URL（用户/模型可能粘贴带 utm、answer 路径或省略域名的链接） */
export function normalizeQuestionUrl(input) {
  if (!input) return null;
  const match = String(input).match(/(?:zhihu\.com\/)?question\/(\d+)/i);
  if (!match) return null;
  return `https://www.zhihu.com/question/${match[1]}`;
}

/** 精简搜索结果条目：保留证据字段，摘要截断控制上下文体积 */
function compactSearchItem(item, maxSummary = 600) {
  return {
    title: item.Title,
    type: item.ContentType,
    id: item.ContentID,
    summary: String(item.ContentText || '').slice(0, maxSummary),
    url: item.Url,
    votes: item.VoteUpCount ?? 0,
    comments: item.CommentCount ?? 0,
    author: item.AuthorName,
    authority: item.AuthorityLevel ?? null,
    ranking: item.RankingScore ?? null,
    comment_samples: Array.isArray(item.CommentInfoList) ? item.CommentInfoList.slice(0, 3).map((c) => c.Content) : null,
  };
}

function compactAnswerItem(item, index) {
  return {
    rank: index + 1,
    type: item.ContentType,
    id: item.ContentToken,
    summary: String(item.Summary || '').slice(0, 400),
    url: item.Url,
  };
}

export function createZhihu({ db, gate, secret, fetchImpl, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const http = fetchImpl ?? fetch;
  const inflight = new Map();
  const callLog = { zhihu_search: 0, global_search: 0, question_answers: 0, hot_list: 0, quota: 0 };

  async function rawRequest(pathname, params = {}) {
    const url = new URL(BASE + pathname);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    const headers = {
      Authorization: `Bearer ${secret}`,
      'X-Request-Timestamp': String(Math.floor(now() / 1000)),
      'Content-Type': 'application/json',
    };
    const response = await http(url, { headers });
    let payload;
    try { payload = await response.json(); }
    catch { throw new ZhihuApiError(`知乎接口返回无法解析的响应（HTTP ${response.status}）`, 'BAD_RESPONSE'); }

    const code = payload?.Code ?? payload?.code;
    if (code === 30001) throw new RateLimitError(payload?.Message || '频率限制');
    if (code === 20001) throw new ZhihuAuthError();
    if (code !== 0 && code !== undefined) throw new ZhihuApiError(payload?.Message || `知乎接口错误 ${code}`, String(code));
    return payload?.Data ?? payload?.data;
  }

  /** 带一次重试的请求（30001 限流等瞬态错误） */
  async function requestWithRetry(pathname, params) {
    try {
      return await gate.withUpstream('zhihu', () => rawRequest(pathname, params));
    } catch (error) {
      if (error instanceof RateLimitError) {
        await sleep(1200);
        return gate.withUpstream('zhihu', () => rawRequest(pathname, params));
      }
      throw error;
    }
  }

  /** 缓存 + single-flight 包装 */
  async function cachedCall({ apiType, cacheKey, loader }) {
    if (db) {
      const cached = apiType === 'question_answers'
        ? db.getQaCache(cacheKey)
        : db.getSearchCache(apiType, cacheKey);
      if (cached) return { ...cached, cached: true };
    }
    const existing = inflight.get(cacheKey);
    if (existing) return existing;

    const promise = (async () => {
      const fresh = await loader();
      if (db) {
        if (apiType === 'question_answers') db.setQaCache(cacheKey, fresh.questionUrl, fresh);
        else db.setSearchCache(apiType, cacheKey, fresh);
      }
      return { ...fresh, cached: false };
    })().finally(() => inflight.delete(cacheKey));
    inflight.set(cacheKey, promise);
    return promise;
  }

  return {
    callLog,
    get configured() { return Boolean(secret); },

    /** 站内搜索（富字段：赞数/权威/评论/相关性），Count ≤10 */
    async search(query, { count = 10 } = {}) {
      const cacheKey = searchCacheKey('zhihu_search', { query, count });
      return cachedCall({
        apiType: 'zhihu_search', cacheKey,
        loader: async () => {
          const data = await requestWithRetry('/content/zhihu_search', { Query: query, Count: count });
          callLog.zhihu_search++;
          const items = (data?.Items || []).map(compactSearchItem);
          return { query, items };
        },
      });
    },

    /** 全网搜索（Filter 高级语法，Count ≤20） */
    async globalSearch(query, { count = 10, filter, searchDB } = {}) {
      const cacheKey = searchCacheKey('global_search', { query, count, filter, searchDB });
      return cachedCall({
        apiType: 'global_search', cacheKey,
        loader: async () => {
          const data = await requestWithRetry('/content/global_search', { Query: query, Count: count, Filter: filter, SearchDB: searchDB });
          callLog.global_search++;
          const items = (data?.Items || []).map(compactSearchItem);
          return { query, items };
        },
      });
    },

    /** 问题下的回答列表（默认排序≈社区标杆序）；qa_cache TTL 7 天，最紧额度约束 */
    async questionAnswers(questionUrl, { limit = 20 } = {}) {
      const normalized = normalizeQuestionUrl(questionUrl);
      if (!normalized) throw new ZhihuApiError('无法从输入中识别知乎问题 URL', 'BAD_QUESTION_URL');
      const cacheKey = searchCacheKey('question_answers', { questionUrl: normalized, limit });
      return cachedCall({
        apiType: 'question_answers', cacheKey,
        loader: async () => {
          const data = await requestWithRetry('/content/question_answers', { QuestionUrl: normalized, Offset: 0, Limit: limit });
          callLog.question_answers++;
          const items = (data?.Items || []).map(compactAnswerItem);
          return { questionUrl: normalized, items, isEnd: data?.Paging?.IsEnd ?? null };
        },
      });
    },

    /** 热榜（选题雷达入口用，缓存 10 分钟） */
    async hotList(limit = 10) {
      const cacheKey = searchCacheKey('hot_list', { limit });
      return cachedCall({
        apiType: 'hot_list', cacheKey,
        loader: async () => {
          const data = await requestWithRetry('/content/hot_list', { Limit: limit });
          callLog.hot_list++;
          const items = (data?.Items || []).map((item) => ({ title: item.Title, url: item.Url, summary: String(item.Summary || '').slice(0, 120) }));
          return { items };
        },
      });
    },

    /** 额度查询（不消耗额度、不缓存）——启动自检与降级判断用 */
    async quota(apiIds) {
      const data = await gate.withUpstream('zhihu', () => rawRequest('/quota', apiIds?.length ? { APIIDs: apiIds.join(',') } : {}));
      callLog.quota++;
      return Array.isArray(data) ? data : [];
    },
  };
}

/** 冒烟/测试用 mock fetch：LLM_MOCK 同族，SMOKE 模式下无需真实 Secret
 *  MOCK_LATENCY_MS 可调延迟（压测用：模拟真实检索 0.7s 量级，让并发闸门排队可被触发验证） */
export function createMockZhihuFetch() {
  const latency = Number(process.env.MOCK_LATENCY_MS ?? 30);
  return async (url) => {
    const target = String(url);
    await new Promise((r) => setTimeout(r, latency));
    if (target.includes('/zhihu_search')) {
      return jsonResponse({ Code: 0, Data: { Items: [
        { Title: '机器学习入门路线（mock）', ContentType: 'Article', ContentID: '1001', ContentText: '建议先补数学基础：线性代数、概率论与凸优化是三大支柱。随后跟一门体系化课程……'.repeat(2), Url: 'https://zhuanlan.zhihu.com/p/1001', CommentCount: 12, VoteUpCount: 88, AuthorName: '林轩田课程笔记', AuthorityLevel: '4', RankingScore: 1.92, CommentInfoList: [{ Content: '数学基础真的重要，别跳过' }] },
        { Title: '怎么开始学机器学习？', ContentType: 'Question', ContentID: '2002', ContentText: '知乎问题页', Url: 'https://www.zhihu.com/question/20691338', CommentCount: 0, VoteUpCount: 0, AuthorName: '知乎用户', AuthorityLevel: '3', RankingScore: 1.75 },
        { Title: 'CS229 数学推导路线（mock 回答）', ContentType: 'Answer', ContentID: '53910077', ContentText: '入门直接上 CS229，先掌握监督学习的数学推导……', Url: 'https://www.zhihu.com/question/20691338/answer/53910077', CommentCount: 5, VoteUpCount: 4200, AuthorName: '时光纪', AuthorityLevel: 'L4', RankingScore: 1.88 },
      ] } });
    }
    if (target.includes('/question_answers')) {
      return jsonResponse({ Code: 0, Data: { Items: [
        { ContentType: 'Answer', ContentToken: '53910077', Url: 'https://www.zhihu.com/answer/53910077', Summary: '入门直接上 CS229，先掌握监督学习的数学推导，再补工程实践……' },
        { ContentType: 'Answer', ContentToken: '22465357', Url: 'https://www.zhihu.com/answer/22465357', Summary: '数学基础不必等全学完，边做项目边补效率更高……' },
        { ContentType: 'Answer', ContentToken: '30001111', Url: 'https://www.zhihu.com/answer/30001111', Summary: '推荐吴恩达课程 + 西瓜书组合，配合 Kaggle 入门赛……' },
      ], Paging: { IsEnd: false } } });
    }
    if (target.includes('/hot_list')) {
      return jsonResponse({ Code: 0, Data: { Total: 2, Items: [
        { Title: 'AI 时代还需要学编程吗？', Url: 'https://www.zhihu.com/question/90001', ThumbnailUrl: '', Summary: '热榜问题' },
        { Title: '2026 应届生求职风向', Url: 'https://www.zhihu.com/question/90002', ThumbnailUrl: '', Summary: '' },
      ] } });
    }
    if (target.includes('/quota')) {
      return jsonResponse({ Code: 0, Data: [
        { APIID: 'zhihu_search', APIName: '知乎搜索', TotalQuota: 5000, TotalUsed: 0, RemainingQuota: 5000 },
      ] });
    }
    return jsonResponse({ Code: 0, Data: {} });
  };
}

function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload };
}
