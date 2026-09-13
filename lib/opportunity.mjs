// 热榜机会榜（P2）：预计算「今日热榜上还缺好回答的 3 个问题」
// 数据链：hot_list（100/天额度）+ 每个候选问题 1 次 zhihu_search（5000/天额度，富余）；
// 纯规则评分（不烧 LLM token），结果走 search_cache 每日缓存（api_type 'opportunities'，TTL 见 db.mjs）
export const OPPORTUNITY_COUNT = 3;
const CANDIDATE_COUNT = 8;
const SEARCH_COUNT = 10;

/** 空缺度评分（纯函数，可单测）：0-100，越高 = 越缺好回答
 *  口径透明可解释：已有讨论的证据量 = 赞数(≤40) + L4权威条数(≤30) + 深度内容条数(≤30) + 问题被索引收录(+10)
 *  gap = 100 - 证据量。gap 高 = 该热榜问题相关的高赞/权威/深度回答少 → 写好回答的机会大 */
export function scoreOpportunity(hotItem, searchResult) {
  const items = searchResult?.items || [];
  const resultCount = items.length;
  const maxVotes = items.reduce((max, item) => Math.max(max, Number(item.votes) || 0), 0);
  const l4Count = items.filter((item) => String(item.authority || '').includes('4')).length;
  const deepCount = items.filter((item) => String(item.summary || '').length >= 600).length;
  const questionIndexed = Boolean(hotItem?.url) && items.some((item) => String(item.url || '').startsWith(hotItem.url));

  const votesScore = Math.min(40, maxVotes / 25); // 1000 赞封顶
  const authorityScore = Math.min(30, l4Count * 10);
  const depthScore = Math.min(30, deepCount * 6);
  const coverageScore = Math.round(votesScore + authorityScore + depthScore + (questionIndexed ? 10 : 0));
  const gap = Math.max(0, 100 - coverageScore);

  const parts = [`相关内容 ${resultCount} 条`, `最高 ${maxVotes} 赞`, `L4 权威 ${l4Count} 条`];
  if (questionIndexed) parts.push('问题已出现在搜索结果'); // D5：原「索引收录」是搜索引擎内部概念，改用用户可懂的说法
  return { gap, reason: parts.join(' · '), stats: { resultCount, maxVotes, l4Count, deepCount, questionIndexed } };
}

// 机会榜边界声明（固定口径，不随缓存数据存取——旧缓存条目也始终携带）
export const OPPORTUNITY_NOTE = '空缺度基于该问题标题的近期站内检索估算：站内搜索偏近期内容，早年高赞标杆回答可能未被收录，仅供选题参考。';

export function createOpportunity({ zhihu, db, now = Date.now } = {}) {
  const cacheKey = 'opportunities:daily';

  async function compute() {
    const hot = await zhihu.hotList(20);
    const candidates = hot.items.slice(0, CANDIDATE_COUNT);
    const scored = [];
    for (const item of candidates) {
      try {
        const query = String(item.title || '').slice(0, 40);
        if (!query) continue;
        const search = await zhihu.search(query, { count: SEARCH_COUNT });
        const { gap, reason, stats } = scoreOpportunity(item, search);
        scored.push({ title: item.title, url: item.url, gap, reason, stats });
      } catch { /* 单个候选失败跳过，不拖垮整榜 */ }
    }
    if (!scored.length) throw Object.assign(new Error('机会榜候选为空（热榜或搜索不可用）'), { code: 'OPPORTUNITY_EMPTY' });
    scored.sort((a, b) => b.gap - a.gap);
    return {
      items: scored.slice(0, OPPORTUNITY_COUNT).map((item, index) => ({ rank: index + 1, ...item })),
      candidates: scored.length,
      generated_at: new Date(now()).toISOString(),
    };
  }

  return {
    /** 读取机会榜：缓存命中秒回；过期/force 则现算（≤8 次搜索，约 6s）后落缓存
     *  边界声明固定附加（不属于缓存数据）——旧缓存条目同样携带，避免口径说明随缓存版本丢失 */
    async get({ force = false } = {}) {
      if (!force) {
        const cached = db.getSearchCache('opportunities', cacheKey);
        if (cached) return { ...cached, note: OPPORTUNITY_NOTE, cached: true };
      }
      const fresh = await compute();
      db.setSearchCache('opportunities', cacheKey, fresh);
      return { ...fresh, note: OPPORTUNITY_NOTE, cached: false };
    },
  };
}
