/**
 * 结构化记忆存储层 — 从 Nine structured/storage.py 翻译
 *
 * SQLite 存储：memory_profiles + memory_facts + memory_facts_fts（FTS5 trigram）
 */
import Database from 'better-sqlite3';
import path from 'path';

import { STORE_DIR } from '../config.js';
import { logger } from '../logger.js';
import { getMemoryConfig } from './config.js';
import {
  bufferToEmbedding,
  cosineSimilarity,
  embeddingToBuffer,
  getEmbedding,
} from './embeddings.js';

export interface MemoryFact {
  id: string;
  groupFolder: string;
  content: string;
  category: string;
  confidence: number;
  source: string;
  embedding: number[] | null;
  createdAt: string;
}

export interface MemoryProfile {
  groupFolder: string;
  profileJson: Record<string, unknown>;
  updatedAt: string;
}

let _db: Database.Database | null = null;
let _ftsAvailable: boolean | null = null;

export function getMemoryDb(): Database.Database {
  if (_db) return _db;
  const dbPath = path.join(STORE_DIR, 'memory.db');
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  initMemoryDb(_db);
  return _db;
}

/** 关闭数据库（测试清理用） */
export function closeMemoryDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    _ftsAvailable = null;
  }
}

function initMemoryDb(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_profiles (
      group_folder TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '',
      profile_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (group_folder, user_id)
    );

    CREATE TABLE IF NOT EXISTS memory_facts (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'context',
      confidence REAL NOT NULL DEFAULT 0.0,
      source TEXT,
      embedding BLOB,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_facts_group ON memory_facts(group_folder);
    CREATE INDEX IF NOT EXISTS idx_facts_group_user ON memory_facts(group_folder, user_id);
  `);

  // FTS5 trigram 虚拟表（W2 修复：用 trigram tokenizer 支持中文子串匹配）
  initFtsTable(db);
}

function initFtsTable(db: Database.Database): void {
  if (_ftsAvailable !== null) return;
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_facts_fts
      USING fts5(content, fact_id UNINDEXED, tokenize='trigram');
    `);
    _ftsAvailable = true;
    logger.debug('FTS5 trigram 虚拟表初始化成功');
  } catch (err) {
    _ftsAvailable = false;
    logger.warn({ err }, 'FTS5 不可用，关键词检索将回退到 LIKE');
  }
}

export function isFtsAvailable(): boolean {
  if (_ftsAvailable === null) {
    getMemoryDb(); // 触发初始化
  }
  return _ftsAvailable === true;
}

// ─────────────────────────────────────────────────────────────
// Profile CRUD
// ─────────────────────────────────────────────────────────────

export function loadProfile(): Record<string, unknown> | null {
  const db = getMemoryDb();
  // 整库查：取最近更新的 profile
  const row = db
    .prepare(
      'SELECT profile_json FROM memory_profiles ORDER BY updated_at DESC LIMIT 1',
    )
    .get() as { profile_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.profile_json);
  } catch {
    logger.warn('解析 profile JSON 失败');
    return null;
  }
}

export function saveProfile(
  groupFolder: string,
  data: Record<string, unknown>,
  userId: string = '',
): void {
  const db = getMemoryDb();
  const json = JSON.stringify(data, null, 0);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO memory_profiles (group_folder, user_id, profile_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(group_folder, user_id) DO UPDATE SET profile_json = excluded.profile_json, updated_at = excluded.updated_at`,
  ).run(groupFolder, userId, json, now);
}

// ─────────────────────────────────────────────────────────────
// Facts CRUD
// ─────────────────────────────────────────────────────────────

// facts 缓存（TTL 30 秒，避免每条消息都全量读 SQLite）
let _factsCache: MemoryFact[] | null = null;
let _factsCacheTime = 0;
const FACTS_CACHE_TTL = 30_000; // 30 秒

/** 强制刷新 facts 缓存（新记忆写入后调用） */
export function invalidateFactsCache(): void {
  _factsCache = null;
  _factsCacheTime = 0;
}

export function loadFacts(): MemoryFact[] {
  // TTL 缓存命中
  if (_factsCache && Date.now() - _factsCacheTime < FACTS_CACHE_TTL) {
    return _factsCache;
  }

  const db = getMemoryDb();
  // 整库查：不按 group_folder 也不按 user_id 过滤
  const rows = db
    .prepare(
      `SELECT id, group_folder, content, category, confidence, source, embedding, created_at
       FROM memory_facts
       ORDER BY confidence DESC`,
    )
    .all() as Array<{
    id: string;
    group_folder: string;
    content: string;
    category: string;
    confidence: number;
    source: string | null;
    embedding: Buffer | null;
    created_at: string;
  }>;

  _factsCache = rows.map((r) => ({
    id: r.id,
    groupFolder: r.group_folder,
    content: r.content,
    category: r.category,
    confidence: r.confidence,
    source: r.source || '',
    embedding: r.embedding ? bufferToEmbedding(r.embedding) : null,
    createdAt: r.created_at,
  }));
  _factsCacheTime = Date.now();
  return _factsCache;
}

/**
 * 存储 facts（含字符串精确去重 + 向量语义去重）
 * 返回实际存入的 fact 数量
 */
export async function storeFacts(
  groupFolder: string,
  facts: Array<{
    id: string;
    content: string;
    category: string;
    confidence: number;
    source: string;
  }>,
  userId: string = '',
): Promise<number> {
  if (facts.length === 0) return 0;

  const db = getMemoryDb();
  const existing = loadFacts();
  const existingContents = new Set(existing.map((f) => f.content.trim()));

  // 收集已有的 embeddings 用于语义去重
  const existingEmbeddings = existing
    .filter((f) => f.embedding !== null)
    .map((f) => f.embedding!);

  const insertFact = db.prepare(
    `INSERT OR IGNORE INTO memory_facts (id, group_folder, user_id, content, category, confidence, source, embedding, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertFts = isFtsAvailable()
    ? db.prepare(
        'INSERT INTO memory_facts_fts (content, fact_id) VALUES (?, ?)',
      )
    : null;

  let storedCount = 0;
  const now = new Date().toISOString();

  for (const fact of facts) {
    const content = fact.content.trim();
    if (!content) continue;

    // 字符串精确去重
    if (existingContents.has(content)) {
      logger.debug({ content: content.slice(0, 50) }, 'Fact 精确重复，跳过');
      continue;
    }

    // 生成 embedding
    const embedding = await getEmbedding(content);

    // 向量语义去重：cosine > 0.95 视为重复
    if (embedding && existingEmbeddings.length > 0) {
      const isDuplicate = existingEmbeddings.some(
        (e) => cosineSimilarity(embedding, e) > 0.95,
      );
      if (isDuplicate) {
        logger.debug(
          { content: content.slice(0, 50) },
          'Fact 语义重复 (cosine>0.95)，跳过',
        );
        continue;
      }
    }

    const embeddingBlob = embedding ? embeddingToBuffer(embedding) : null;

    insertFact.run(
      fact.id,
      groupFolder,
      userId,
      content,
      fact.category,
      fact.confidence,
      fact.source,
      embeddingBlob,
      now,
    );

    // 同步 FTS5 索引
    if (insertFts) {
      try {
        insertFts.run(content, fact.id);
      } catch (err) {
        logger.debug({ err, factId: fact.id }, 'FTS 插入失败');
      }
    }

    existingContents.add(content);
    if (embedding) existingEmbeddings.push(embedding);
    storedCount++;
  }

  if (storedCount > 0) {
    invalidateFactsCache();
    logger.info({ groupFolder, count: storedCount }, 'Facts 已存储');
  }
  return storedCount;
}

/**
 * 快速存储一条 fact，不调用 embedding API。
 * 用于 memory_remember 的阶段 1（先保证数据不丢失）。
 */
export function storeFactRaw(
  groupFolder: string,
  fact: {
    id: string;
    content: string;
    category: string;
    confidence: number;
    source: string;
  },
  userId: string = '',
): void {
  const db = getMemoryDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO memory_facts (id, group_folder, user_id, content, category, confidence, source, embedding, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    fact.id,
    groupFolder,
    userId,
    fact.content.trim(),
    fact.category,
    fact.confidence,
    fact.source,
    now,
  );

  // 同步 FTS5
  if (isFtsAvailable()) {
    try {
      getMemoryDb()
        .prepare(
          'INSERT INTO memory_facts_fts (content, fact_id) VALUES (?, ?)',
        )
        .run(fact.content.trim(), fact.id);
    } catch {
      // 忽略重复
    }
  }

  invalidateFactsCache();
}

/**
 * 更新已有 fact 的内容/类别/置信度/embedding。
 * 用于 memory_remember 阶段 2（LLM 标准化后回写）。
 */
export function updateFact(
  factId: string,
  updates: {
    content?: string;
    category?: string;
    confidence?: number;
    embedding?: number[] | null;
  },
): boolean {
  const db = getMemoryDb();

  const old = db
    .prepare('SELECT content FROM memory_facts WHERE id = ?')
    .get(factId) as { content: string } | undefined;
  if (!old) return false;

  const sets: string[] = [];
  const params: unknown[] = [];
  if (updates.content !== undefined) {
    sets.push('content = ?');
    params.push(updates.content.trim());
  }
  if (updates.category !== undefined) {
    sets.push('category = ?');
    params.push(updates.category);
  }
  if (updates.confidence !== undefined) {
    sets.push('confidence = ?');
    params.push(updates.confidence);
  }
  if (updates.embedding !== undefined) {
    sets.push('embedding = ?');
    params.push(
      updates.embedding ? embeddingToBuffer(updates.embedding) : null,
    );
  }
  if (sets.length === 0) return false;

  params.push(factId);
  db.prepare(`UPDATE memory_facts SET ${sets.join(', ')} WHERE id = ?`).run(
    ...params,
  );

  // FTS 更新：先删后插
  if (updates.content !== undefined && isFtsAvailable()) {
    try {
      db.prepare('DELETE FROM memory_facts_fts WHERE fact_id = ?').run(factId);
      db.prepare(
        'INSERT INTO memory_facts_fts (content, fact_id) VALUES (?, ?)',
      ).run(updates.content.trim(), factId);
    } catch {
      // FTS 更新失败不阻塞
    }
  }

  invalidateFactsCache();
  return true;
}

export function removeFacts(factIds: string[]): number {
  if (factIds.length === 0) return 0;
  const db = getMemoryDb();
  const deleteFact = db.prepare('DELETE FROM memory_facts WHERE id = ?');
  const deleteFts = isFtsAvailable()
    ? db.prepare('DELETE FROM memory_facts_fts WHERE fact_id = ?')
    : null;

  let removed = 0;
  for (const id of factIds) {
    const result = deleteFact.run(id);
    if (result.changes > 0) {
      removed++;
      if (deleteFts) {
        try {
          deleteFts.run(id);
        } catch {
          // FTS 条目可能不存在（旧数据）
        }
      }
    }
  }

  if (removed > 0) {
    logger.info({ count: removed }, 'Facts 已删除');
  }
  return removed;
}

/**
 * 超限清理：按 (置信度 + 时间加权) 排序，删除多余 facts。
 * 近 7 天加 0.1 分，近 30 天加 0.05 分。
 */
export function enforceMaxFacts(
  groupFolder: string,
  maxFacts?: number,
  userId: string = '',
): number {
  const config = getMemoryConfig();
  const limit = maxFacts ?? config.maxFacts;
  const db = getMemoryDb();

  const rows = db
    .prepare(
      'SELECT id, confidence, created_at FROM memory_facts WHERE user_id = ?',
    )
    .all(userId) as Array<{
    id: string;
    confidence: number;
    created_at: string;
  }>;

  if (limit <= 0 || rows.length <= limit) return 0;

  const now = Date.now();
  const DAY_MS = 86400_000;

  const scored = rows.map((r) => {
    const createdMs = new Date(r.created_at).getTime();
    const ageDays = (now - createdMs) / DAY_MS;
    let recencyBonus = 0;
    if (ageDays < 7) recencyBonus = 0.1;
    else if (ageDays < 30) recencyBonus = 0.05;
    return { id: r.id, score: r.confidence + recencyBonus };
  });

  // 按加权分数降序
  scored.sort((a, b) => b.score - a.score);

  // 保留 top limit，删除剩余
  const toRemove = scored.slice(limit).map((s) => s.id);
  return removeFacts(toRemove);
}

/**
 * 补录已有 facts 到 FTS 索引（T5 建表后调用一次）
 */
export function backfillFtsIndex(groupFolder?: string): number {
  if (!isFtsAvailable()) return 0;
  const db = getMemoryDb();

  const query = groupFolder
    ? db.prepare(
        `SELECT f.id, f.content FROM memory_facts f
         LEFT JOIN memory_facts_fts fts ON fts.fact_id = f.id
         WHERE f.group_folder = ? AND fts.fact_id IS NULL`,
      )
    : db.prepare(
        `SELECT f.id, f.content FROM memory_facts f
         LEFT JOIN memory_facts_fts fts ON fts.fact_id = f.id
         WHERE fts.fact_id IS NULL`,
      );

  const rows = (groupFolder ? query.all(groupFolder) : query.all()) as Array<{
    id: string;
    content: string;
  }>;

  if (rows.length === 0) return 0;

  const insert = db.prepare(
    'INSERT INTO memory_facts_fts (content, fact_id) VALUES (?, ?)',
  );
  let count = 0;
  for (const r of rows) {
    try {
      insert.run(r.content, r.id);
      count++;
    } catch {
      // 忽略重复
    }
  }
  logger.info({ count }, 'FTS 索引补录完成');
  return count;
}
