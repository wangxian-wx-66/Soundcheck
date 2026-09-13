// 机会榜单测（P2，全 mock，不烧知乎额度）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../lib/db.mjs';
import { createOpportunity, scoreOpportunity, OPPORTUNITY_COUNT } from '../lib/opportunity.mjs';

function tempDir() { return mkdtempSync(path.join(tmpdir(), 'soundcheck-opp-')); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mockZhihu({ hotItems, searchResultsByTitle }) {
  let searchCalls = 0;
  return {
    searchCalls: () => searchCalls,
    async hotList() { await sleep(5); return { items: hotItems, cached: false }; },
    async search(query) {
      searchCalls++;
      await sleep(5);
      return { query, items: searchResultsByTitle(query) || [] };
    },
  };
}

// ---------- 评分纯函数 ----------
test('score: 高赞 + L4 权威覆盖充分 → 低空缺度', () => {
  const { gap, reason, stats } = scoreOpportunity(
    { title: '问题A', url: 'https://www.zhihu.com/question/1' },
    { items: [
      { votes: 1000, authority: '4', summary: 'x'.repeat(700), url: 'https://www.zhihu.com/question/1/answer/1' },
      { votes: 500, authority: 'L4', summary: 'y'.repeat(800), url: 'https://zhuanlan.zhihu.com/p/1' },
      { votes: 200, authority: '3', summary: 'z', url: 'https://www.zhihu.com/question/2/answer/2' },
    ] },
  );
  // 赞 40 + 权威 20 + 深度 12 + 收录 10 = 82 → gap 18
  assert.equal(gap, 18);
  assert.equal(stats.l4Count, 2);
  assert.equal(stats.questionIndexed, true);
  assert.match(reason, /相关内容 3 条/);
  assert.match(reason, /问题已出现在搜索结果/);
});

test('score: 相关内容稀缺 → 高空缺度（缺好回答）', () => {
  const { gap, stats } = scoreOpportunity(
    { title: '问题B', url: 'https://www.zhihu.com/question/9' },
    { items: [{ votes: 12, authority: '3', summary: '短', url: 'https://zhuanlan.zhihu.com/p/9' }] },
  );
  // 赞 0.48 + 权威 0 + 深度 0 + 未收录 0 → gap ≥ 99
  assert.ok(gap >= 99, `gap=${gap}`);
  assert.equal(stats.questionIndexed, false);
});

test('score: 空结果 → gap 100，不抛错', () => {
  const { gap } = scoreOpportunity({ title: 'x', url: 'u' }, { items: [] });
  assert.equal(gap, 100);
});

// ---------- 缓存与排序 ----------
test('opportunity: 空缺度排序取前 3 + 每日缓存命中（不重算）', async () => {
  const db = openDb(tempDir());
  const zhihu = mockZhihu({
    hotItems: Array.from({ length: 6 }, (_, i) => ({ title: `热榜问题${i}`, url: `https://www.zhihu.com/question/${100 + i}` })),
    searchResultsByTitle: (query) => {
      const index = Number(query.match(/(\d+)$/)?.[1] ?? 0);
      // 偶数序：覆盖充分（低 gap）；奇数序：稀缺（高 gap）
      return index % 2 === 0
        ? [{ votes: 900, authority: '4', summary: '深'.repeat(800), url: `https://www.zhihu.com/question/${100 + index}/answer/1` }]
        : [{ votes: 3, authority: '3', summary: '短', url: 'https://zhuanlan.zhihu.com/p/x' }];
    },
  });
  const opportunity = createOpportunity({ zhihu, db });

  const first = await opportunity.get();
  assert.equal(first.cached, false);
  assert.equal(first.items.length, OPPORTUNITY_COUNT);
  // 奇数序 gap 高，应占据前三
  assert.ok(first.items.every((item) => /热榜问题[135]/.test(item.title)), JSON.stringify(first.items.map((i) => i.title)));
  assert.equal(first.items[0].rank, 1);
  const callsAfterFirst = zhihu.searchCalls();
  assert.equal(callsAfterFirst, 6, '6 个候选各搜一次');

  // 二次调用：缓存命中，零搜索
  const second = await opportunity.get();
  assert.equal(second.cached, true);
  assert.deepEqual(second.items, first.items);
  assert.equal(zhihu.searchCalls(), callsAfterFirst);

  // force：重新计算
  const third = await opportunity.get({ force: true });
  assert.equal(third.cached, false);
  assert.ok(zhihu.searchCalls() > callsAfterFirst);
});

test('opportunity: 候选搜索单项失败跳过，不拖垮整榜', async () => {
  const db = openDb(tempDir());
  const zhihu = {
    async hotList() { return { items: [{ title: '好问题', url: 'u1' }, { title: '坏问题', url: 'u2' }] }; },
    async search(query) {
      if (query.includes('坏问题')) throw new Error('搜索失败');
      return { items: [{ votes: 5, authority: '2', summary: 's', url: 'a' }] };
    },
  };
  const result = await createOpportunity({ zhihu, db }).get();
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].title, '好问题');
});

test('opportunity: 全部候选失败 → 显式错误（不静默空榜）', async () => {
  const db = openDb(tempDir());
  const zhihu = {
    async hotList() { return { items: [{ title: 'x', url: 'u' }] }; },
    async search() { throw new Error('boom'); },
  };
  await assert.rejects(() => createOpportunity({ zhihu, db }).get(), (error) => error.code === 'OPPORTUNITY_EMPTY');
});

// ---------- TTL（走真实 db 缓存路径） ----------
test('opportunity: 缓存 TTL 过期后重算（opportunities 13h）', async () => {
  let now = Date.now();
  const db = openDb(tempDir(), { now: () => now });
  const zhihu = mockZhihu({
    hotItems: [{ title: '热榜问题', url: 'u' }],
    searchResultsByTitle: () => [{ votes: 10, authority: '3', summary: 's', url: 'a' }],
  });
  const opportunity = createOpportunity({ zhihu, db, now: () => now });
  const first = await opportunity.get();
  assert.equal(first.cached, false);
  now += 14 * 3600_000; // 快进 14h > 13h TTL
  const second = await opportunity.get();
  assert.equal(second.cached, false);
  assert.ok(zhihu.searchCalls() >= 2);
});

test('opportunity: 真实 db 往返（含 TTL 内缓存）', async () => {
  const db = openDb(tempDir());
  const zhihu = mockZhihu({
    hotItems: [{ title: '真实库缓存', url: 'u' }],
    searchResultsByTitle: () => [{ votes: 7, authority: '3', summary: 's', url: 'a' }],
  });
  const opportunity = createOpportunity({ zhihu, db });
  const first = await opportunity.get();
  const second = await opportunity.get();
  assert.equal(second.cached, true);
  assert.deepEqual(second.items, first.items);
  assert.ok(second.generated_at);
});
