// 数据层：SQLite 三表 + WAL + 预编译语句 + 启动自检重建
// 表：search_cache（搜索缓存 TTL 24h / 热榜 10min）/ qa_cache（问题→回答列表 TTL 7天）/ reports（报告 LRU 1000）
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';

export const SEARCH_TTL_MS = {
  zhihu_search: 24 * 3600_000,
  global_search: 24 * 3600_000,
  hot_list: 10 * 60_000,
};
export const QA_TTL_MS = 7 * 24 * 3600_000;
export const REPORTS_MAX = 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS search_cache (
  cache_key  TEXT PRIMARY KEY,
  api_type   TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS qa_cache (
  cache_key    TEXT PRIMARY KEY,
  question_url TEXT NOT NULL,
  payload      TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  run_id     TEXT PRIMARY KEY,
  mode       TEXT NOT NULL,
  question   TEXT NOT NULL,
  result     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_search_cache_type_time ON search_cache(api_type, created_at);
CREATE INDEX IF NOT EXISTS idx_reports_time ON reports(created_at);
`;

export function openDb(dataDir, { now = Date.now } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'soundcheck.db');

  // 打开 + 建表自检；损坏则改名 .corrupt 备份后重建（数据均可再生）
  let db;
  try {
    db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(SCHEMA);
    db.prepare('SELECT count(*) AS n FROM reports').get();
  } catch (error) {
    try { db?.close(); } catch { /* 忽略 */ }
    const backup = `${file}.corrupt-${now()}`;
    if (existsSync(file)) {
      try { renameSync(file, backup); } catch { /* 重建失败再兜底 */ }
    }
    db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(SCHEMA);
  }

  const stmt = {
    searchGet: db.prepare('SELECT payload, created_at FROM search_cache WHERE cache_key = ?'),
    searchSet: db.prepare('INSERT OR REPLACE INTO search_cache (cache_key, api_type, payload, created_at) VALUES (?, ?, ?, ?)'),
    qaGet: db.prepare('SELECT payload, created_at FROM qa_cache WHERE cache_key = ?'),
    qaSet: db.prepare('INSERT OR REPLACE INTO qa_cache (cache_key, question_url, payload, created_at) VALUES (?, ?, ?, ?)'),
    reportSave: db.prepare('INSERT OR REPLACE INTO reports (run_id, mode, question, result, created_at) VALUES (?, ?, ?, ?, ?)'),
    reportGet: db.prepare('SELECT run_id, mode, question, result, created_at FROM reports WHERE run_id = ?'),
    reportCount: db.prepare('SELECT count(*) AS n FROM reports'),
    // LRU：保留最新 REPORTS_MAX 条，删除更早的
    reportTrim: db.prepare(`
      DELETE FROM reports WHERE run_id IN (
        SELECT run_id FROM reports ORDER BY created_at DESC, run_id DESC LIMIT -1 OFFSET ?
      )`),
    stalePurge: db.prepare('DELETE FROM search_cache WHERE created_at < ?'),
    stalePurgeQa: db.prepare('DELETE FROM qa_cache WHERE created_at < ?'),
  };

  let purgeCounter = 0;

  return {
    file,

    /** 搜索类缓存读取（按 api_type 应用 TTL），过期/未命中返回 null */
    getSearchCache(apiType, cacheKey) {
      const row = stmt.searchGet.get(cacheKey);
      if (!row) return null;
      const ttl = SEARCH_TTL_MS[apiType];
      if (ttl !== undefined && now() - row.created_at >= ttl) return null;
      return JSON.parse(row.payload);
    },

    setSearchCache(apiType, cacheKey, payload) {
      stmt.searchSet.run(cacheKey, apiType, JSON.stringify(payload), now());
      if (++purgeCounter % 50 === 0) {
        try {
          stmt.stalePurge.run(now() - 3 * 24 * 3600_000);
          stmt.stalePurgeQa.run(now() - 30 * 24 * 3600_000);
        } catch { /* 清理失败不致命 */ }
      }
    },

    /** 问题 URL → 回答列表缓存（TTL 7 天，省 question_answers 100/天额度） */
    getQaCache(cacheKey) {
      const row = stmt.qaGet.get(cacheKey);
      if (!row || now() - row.created_at >= QA_TTL_MS) return null;
      return JSON.parse(row.payload);
    },

    setQaCache(cacheKey, questionUrl, payload) {
      stmt.qaSet.run(cacheKey, questionUrl, JSON.stringify(payload), now());
    },

    /** 报告落库（result 为三段 JSON；不含草稿原文——隐私承诺） */
    saveReport({ runId, mode, question, result }) {
      stmt.reportSave.run(runId, mode, question, JSON.stringify(result), now());
      try { stmt.reportTrim.run(REPORTS_MAX); } catch { /* trim 失败不致命 */ }
    },

    getReport(runId) {
      const row = stmt.reportGet.get(runId);
      if (!row) return null;
      return { runId: row.run_id, mode: row.mode, question: row.question, result: JSON.parse(row.result), createdAt: row.created_at };
    },

    countReports() { return stmt.reportCount.get().n; },

    close() { try { db.close(); } catch { /* 忽略 */ } },
  };
}
