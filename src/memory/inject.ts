/**
 * 记忆注入模块 — 将记忆格式化后写入 group 目录的 CLAUDE.md
 *
 * 使用 HTML 注释标记 <!-- nanoclaw:memory:start/end --> 包裹，
 * 避免与用户手写内容冲突。
 *
 * 同时导出 buildMessageContext() 用于动态注入（container active 期间）。
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { QdrantClient } from '@qdrant/js-client-rest';

import { getMemoryConfig } from './config.js';
import { loadFacts, loadProfile } from './storage.js';
import { formatMemoryForInjection } from './prompt.js';
import { MemoryStore } from './memory-store.js';
import { getEmbedding } from './embeddings.js';
import { logger } from '../logger.js';
import { GROUPS_DIR, QDRANT_URL } from '../config.js';

// ─── Qdrant wiki 向量 ───

const WIKI_COLLECTION = 'wiki_index_vectors';
const WIKI_VECTOR_SIZE = 1024;
let _qdrant: QdrantClient | null = null;
let _qdrantReady = false;

async function getWikiQdrant(): Promise<QdrantClient | null> {
  if (_qdrantReady) return _qdrant;
  try {
    _qdrant = new QdrantClient({ url: QDRANT_URL, timeout: 5000 });
    const collections = await _qdrant.getCollections();
    const exists = collections.collections.some(
      (c) => c.name === WIKI_COLLECTION,
    );
    if (!exists) {
      await _qdrant.createCollection(WIKI_COLLECTION, {
        vectors: { size: WIKI_VECTOR_SIZE, distance: 'Cosine' },
      });
      logger.info('创建 Qdrant collection: wiki_index_vectors');
    }
    _qdrantReady = true;
    return _qdrant;
  } catch (err) {
    logger.warn({ err }, '[wiki-vector] Qdrant 连接失败，wiki 向量召回不可用');
    _qdrant = null;
    return null;
  }
}

const MEMORY_START = '<!-- nanoclaw:memory:start -->';
const MEMORY_END = '<!-- nanoclaw:memory:end -->';

// ─── 共享类型 ───

export interface WikiMatch {
  title: string;
  path: string;
  snippet: string;
}

export interface FactMatch {
  content: string;
  category: string;
  confidence: number;
}

export interface MessageContext {
  wiki: WikiMatch[];
  facts: FactMatch[];
}

// ─── 共享底层函数 ───

/**
 * 从文本中提取关键词：
 * - 英文：3+ 字符单词
 * - 中文：连续汉字做 bigram 滑窗（"动态记忆" → ["动态", "态记", "记忆"]）
 */
export function extractKeywords(text: string): string[] {
  const tokens: string[] = [];

  // 英文单词
  const enMatches = text.match(/[a-zA-Z]\w{2,}/g) || [];
  for (const w of enMatches) tokens.push(w.toLowerCase());

  // 中文 bigram 滑窗（单字跳过，如"的"、"是"）
  const cnMatches = text.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const seg of cnMatches) {
    if (seg.length <= 4) {
      // 短词整体保留
      tokens.push(seg);
    }
    // bigram 滑窗
    for (let i = 0; i < seg.length - 1; i++) {
      tokens.push(seg.slice(i, i + 2));
    }
  }

  return [...new Set(tokens)]; // 去重
}

// ─── 内存 BM25 ───

const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * 解析 wiki index 文件为条目数组
 */
function parseWikiIndex(
  wikiIndexPath: string,
): Array<{ title: string; path: string; desc: string }> {
  if (!fs.existsSync(wikiIndexPath)) return [];
  const indexContent = fs.readFileSync(wikiIndexPath, 'utf-8');
  const entryRegex = /^- \[([^\]]+)\]\(([^)]+)\)\s*(?:—\s*(.+))?$/gm;
  const entries: Array<{ title: string; path: string; desc: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = entryRegex.exec(indexContent)) !== null) {
    entries.push({ title: match[1], path: match[2], desc: match[3] || '' });
  }
  return entries;
}

/**
 * 对 wiki entries 做 BM25 评分
 */
function bm25Score(
  queryTokens: string[],
  docs: Array<{ tokens: string[]; length: number }>,
  avgDl: number,
): number[] {
  const N = docs.length;
  if (N === 0) return [];

  // 计算每个 query term 的 IDF
  const idf = new Map<string, number>();
  for (const qt of queryTokens) {
    let df = 0;
    for (const doc of docs) {
      if (doc.tokens.some((t) => t.includes(qt) || qt.includes(t))) df++;
    }
    // BM25 IDF: log((N - df + 0.5) / (df + 0.5) + 1)
    idf.set(qt, Math.log((N - df + 0.5) / (df + 0.5) + 1));
  }

  return docs.map((doc) => {
    let score = 0;
    for (const qt of queryTokens) {
      // term frequency: 模糊匹配（子串包含算命中）
      let tf = 0;
      for (const dt of doc.tokens) {
        if (dt.includes(qt) || qt.includes(dt)) tf++;
      }
      if (tf === 0) continue;
      const idfVal = idf.get(qt) || 0;
      score +=
        idfVal *
        ((tf * (BM25_K1 + 1)) /
          (tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / avgDl))));
    }
    return score;
  });
}

// 内存缓存：path → content_hash，避免每条消息都打 Qdrant retrieve
let _wikiHashCache = new Map<string, string>();
let _wikiHashCacheReady = false;

/**
 * 确保 wiki index 条目的向量在 Qdrant 中是最新的（懒初始化 + content_hash 增量更新）
 * 返回 true 表示 Qdrant 可用，供后续 search 使用
 */
async function syncWikiVectors(
  entries: Array<{ title: string; path: string; desc: string }>,
): Promise<boolean> {
  const qdrant = await getWikiQdrant();
  if (!qdrant) return false;

  // 用 path 的 MD5 转 UUID 格式作为稳定 point id（Qdrant 要求 string ID 为 UUID）
  const pathToId = (p: string) => {
    const hex = crypto.createHash('md5').update(p).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  };

  // 首次启动时从 Qdrant 加载已有 hash
  if (!_wikiHashCacheReady) {
    try {
      const existing = await qdrant.retrieve(WIKI_COLLECTION, {
        ids: entries.map((e) => pathToId(e.path)),
        with_payload: true,
        with_vector: false,
      });
      for (const pt of existing) {
        const payload = pt.payload as Record<string, unknown> | null;
        if (payload?.path && payload?.content_hash) {
          _wikiHashCache.set(
            payload.path as string,
            payload.content_hash as string,
          );
        }
      }
    } catch {
      // collection 可能为空，忽略
    }
    _wikiHashCacheReady = true;
  }

  const toEmbed: Array<{
    path: string;
    text: string;
    hash: string;
    title: string;
    desc: string;
  }> = [];
  for (const e of entries) {
    const text = `${e.title} ${e.desc}`;
    const hash = crypto.createHash('md5').update(text).digest('hex');
    if (_wikiHashCache.get(e.path) !== hash) {
      toEmbed.push({ path: e.path, text, hash, title: e.title, desc: e.desc });
    }
  }

  if (toEmbed.length > 0) {
    logger.info(
      { count: toEmbed.length, total: entries.length },
      '[wiki-vector] 向量化 wiki 条目到 Qdrant',
    );
    const points: Array<{
      id: string;
      vector: number[];
      payload: Record<string, unknown>;
    }> = [];
    for (const item of toEmbed) {
      const emb = await getEmbedding(item.text);
      if (emb) {
        points.push({
          id: pathToId(item.path),
          vector: emb,
          payload: {
            path: item.path,
            title: item.title,
            desc: item.desc,
            content_hash: item.hash,
          },
        });
      }
    }
    if (points.length > 0) {
      try {
        await qdrant.upsert(WIKI_COLLECTION, { points });
        // 更新内存缓存
        for (const item of toEmbed) {
          _wikiHashCache.set(item.path, item.hash);
        }
      } catch (upsertErr) {
        logger.error({ err: upsertErr }, '[wiki-vector] Qdrant upsert 失败');
      }
    }
  }

  // 清理已删除的条目：只保留当前 index 中存在的 path
  const validIds = new Set(entries.map((e) => pathToId(e.path)));
  try {
    const allPoints = await qdrant.scroll(WIKI_COLLECTION, {
      limit: 1000,
      with_payload: { include: ['path'] },
      with_vector: false,
    });
    const toDelete = allPoints.points
      .filter((pt) => !validIds.has(pt.id as string))
      .map((pt) => pt.id);
    if (toDelete.length > 0) {
      await qdrant.delete(WIKI_COLLECTION, {
        points: toDelete as string[],
      });
      logger.info(
        { count: toDelete.length },
        '[wiki-vector] 清理已删除的 wiki 条目',
      );
    }
  } catch {
    // 清理失败不影响主流程
  }

  return true;
}

/**
 * 匹配 Wiki index 中的相关条目（BM25 + 向量双路召回）
 */
export async function matchWikiEntries(
  text: string,
  wikiIndexPath: string | string[],
  maxEntries: number = 3,
): Promise<WikiMatch[]> {
  // 支持多个 index 合并召回（team_wiki/index.md + team_wiki/private/index.md）
  const indexPaths = Array.isArray(wikiIndexPath)
    ? wikiIndexPath
    : [wikiIndexPath];
  const entries = indexPaths.flatMap((p) => parseWikiIndex(p));
  if (entries.length === 0) return [];

  const queryTokens = extractKeywords(text);
  if (queryTokens.length === 0) return [];

  // ── BM25 路径 ──
  const docs = entries.map((e) => {
    const tokens = extractKeywords(`${e.title} ${e.desc}`);
    return { tokens, length: tokens.length };
  });
  const avgDl = docs.reduce((s, d) => s + d.length, 0) / docs.length || 1;
  const bm25Scores = bm25Score(queryTokens, docs, avgDl);

  // 归一化 BM25 分数到 [0, 1]
  const maxBm25 = Math.max(...bm25Scores, 1e-9);
  const normBm25 = bm25Scores.map((s) => s / maxBm25);

  // ── 向量路径（Qdrant search）──
  let vectorScores: number[] = new Array(entries.length).fill(0);
  try {
    // 并行：拿 query embedding + 同步 wiki 向量到 Qdrant
    const [queryEmbedding, qdrantReady] = await Promise.all([
      getEmbedding(text),
      syncWikiVectors(entries),
    ]);
    if (queryEmbedding && qdrantReady) {
      const qdrant = await getWikiQdrant();
      if (qdrant) {
        const results = await qdrant.search(WIKI_COLLECTION, {
          vector: queryEmbedding,
          limit: entries.length,
          with_payload: { include: ['path'] },
          score_threshold: 0.01,
        });
        // 将 Qdrant 返回的分数映射回 entries 索引
        const pathToIdx = new Map(entries.map((e, i) => [e.path, i]));
        for (const r of results) {
          const payload = r.payload as Record<string, unknown> | null;
          const p = payload?.path as string;
          const idx = pathToIdx.get(p);
          if (idx !== undefined) {
            vectorScores[idx] = r.score;
          }
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, '[wiki-vector] Qdrant 向量召回失败，仅用 BM25');
  }

  // ── 融合：0.7 * cosine + 0.3 * BM25 ──
  const VECTOR_WEIGHT = 0.7;
  const BM25_WEIGHT = 0.3;
  const fusedScores = entries.map(
    (_, i) => VECTOR_WEIGHT * vectorScores[i] + BM25_WEIGHT * normBm25[i],
  );

  // 按融合分数排序取 top-N
  const scored = entries
    .map((e, i) => ({
      entry: e,
      score: fusedScores[i],
      vecScore: vectorScores[i],
      bm25Score: normBm25[i],
    }))
    .filter((x) => x.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxEntries);

  if (scored.length > 0) {
    logger.info(
      {
        topMatch: scored[0].entry.title,
        topFused: scored[0].score.toFixed(3),
        topVec: scored[0].vecScore.toFixed(3),
        topBm25: scored[0].bm25Score.toFixed(3),
        count: scored.length,
        queryTokens: queryTokens.slice(0, 5),
      },
      '[wiki] 双路召回命中',
    );
  }

  return scored.map((x) => ({
    title: x.entry.title,
    path: x.entry.path,
    snippet: (x.entry.desc || '').slice(0, 200),
  }));
}

/**
 * 通过 MemoryStore 双路召回相关记忆
 */
export async function recallRelevantFacts(
  text: string,
  topK: number = 5,
): Promise<FactMatch[]> {
  const allFacts = loadFacts();
  if (allFacts.length === 0) return [];

  try {
    const store = MemoryStore.getInstance();
    const recalled = await store.recall(text, topK);
    return recalled.map((r) => ({
      content: (r.content || '').slice(0, 100),
      category:
        (r.metadata as Record<string, string> | null)?.category || 'context',
      confidence: r.score,
    }));
  } catch (err) {
    logger.warn({ err }, '记忆召回失败，回退 confidence top-K');
    return allFacts.slice(0, topK).map((f) => ({
      content: (f.content || '').slice(0, 100),
      category: f.category || 'context',
      confidence: f.confidence ?? 0,
    }));
  }
}

// ─── 动态注入：buildMessageContext ───

/**
 * 为当前消息构建动态上下文（Wiki + 记忆），用于 container active 期间的 IPC 传递。
 * 返回 null 表示无匹配（不注入）。
 */
export async function buildMessageContext(
  latestUserMessage: string,
  groupDir?: string,
): Promise<MessageContext | null> {
  const config = getMemoryConfig();
  if (!config.injectionEnabled) return null;

  // Wiki 索引路径：团队库为主，叠加本地私有索引(private 被 .gitignore 隔离，不上传)
  const teamWikiBase = groupDir
    ? path.join(groupDir, '..', 'global', 'team_wiki')
    : path.join(GROUPS_DIR, 'global', 'team_wiki');
  const wikiIndexes = [
    path.join(teamWikiBase, 'index.md'),
    path.join(teamWikiBase, 'private', 'index.md'),
  ];

  const [wikiMatches, facts] = await Promise.all([
    matchWikiEntries(latestUserMessage, wikiIndexes, 3),
    recallRelevantFacts(latestUserMessage, 5),
  ]);

  if (wikiMatches.length === 0 && facts.length === 0) return null;

  return { wiki: wikiMatches, facts };
}

// ─── 去重工具 ───

// per-group context hash，用于连续消息去重
const _lastContextHash = new Map<string, string>();

/**
 * 对 MessageContext 做 hash，用于去重
 */
export function hashContext(ctx: MessageContext): string {
  return crypto.createHash('md5').update(JSON.stringify(ctx)).digest('hex');
}

/**
 * 获取上次 context hash（per group）
 */
export function getLastContextHash(groupFolder: string): string | undefined {
  return _lastContextHash.get(groupFolder);
}

/**
 * 设置 context hash（per group）
 */
export function setLastContextHash(groupFolder: string, hash: string): void {
  _lastContextHash.set(groupFolder, hash);
}

/**
 * 清除 context hash（container 退出时调用）
 */
export function clearContextHash(groupFolder: string): void {
  _lastContextHash.delete(groupFolder);
}

// ─── 冷启动注入：injectMemory（保持原有行为） ───

/**
 * 将记忆注入 group 目录的 CLAUDE.md。
 *
 * R15 改造：
 * - profile 全量注入
 * - facts 走 MemoryStore.recall(latestUserMessage) 双路召回 top-K
 * - latestUserMessage 为空时 fallback 到全量注入
 */
export async function injectMemory(
  groupFolder: string,
  groupDir: string,
  latestUserMessage?: string,
  userId: string = '',
): Promise<void> {
  const config = getMemoryConfig();
  if (!config.injectionEnabled) return;

  // 整库查：不过滤 group_folder 和 user_id
  const profile = loadProfile();
  const allFacts = loadFacts();

  // 没有记忆数据时不操作
  if (!profile && allFacts.length === 0) return;

  // 决定使用哪些 facts（冷启动用完整内容，不截断到 100 字）
  let factsForInjection: Array<{
    id?: string;
    content: string;
    category: string;
    confidence: number;
  }>;

  const TOP_K = 10;

  if (latestUserMessage && allFacts.length > 0) {
    // 双路召回 top-K（复用底层 MemoryStore）
    try {
      const store = MemoryStore.getInstance();
      const recalled = await store.recall(latestUserMessage, TOP_K);
      factsForInjection = recalled.map((r) => ({
        id: r.id,
        content: r.content,
        category:
          (r.metadata as Record<string, string> | null)?.category || 'context',
        confidence: r.score,
      }));
    } catch (err) {
      logger.warn({ err }, '双路召回失败，回退 confidence top-K');
      factsForInjection = allFacts.slice(0, TOP_K);
    }
  } else {
    // 无消息时按 confidence 取 top-K（allFacts 已按 confidence DESC 排序）
    factsForInjection = allFacts.slice(0, TOP_K);
  }

  // Wiki index 关键词匹配（复用 matchWikiEntries）
  let wikiHints = '';
  if (latestUserMessage) {
    const teamWikiBase = path.join(groupDir, '..', 'global', 'team_wiki');
    const wikiIndexPaths = [
      path.join(teamWikiBase, 'index.md'),
      path.join(teamWikiBase, 'private', 'index.md'),
    ];
    const matched = await matchWikiEntries(
      latestUserMessage,
      wikiIndexPaths,
      5,
    );
    if (matched.length > 0) {
      const lines = matched.map(
        (e) =>
          `- [${e.title}](../../global/team_wiki/${e.path})${e.snippet ? ' — ' + e.snippet : ''}`,
      );
      wikiHints =
        '\nWiki 相关条目（需要时可用 Read 工具查看详情）：\n' +
        lines.join('\n');
      logger.info({ matched: matched.length }, '[wiki] 命中 wiki 条目');
    }
  }

  // 组装 memoryData
  const memoryData = {
    user: (profile?.user as Record<string, unknown>) || undefined,
    history: (profile?.history as Record<string, unknown>) || undefined,
    facts: factsForInjection,
  };

  const memoryText = formatMemoryForInjection(memoryData);
  if (!memoryText && !wikiHints) return;

  // 写入 CLAUDE.md
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
  const memoryBlock = `${MEMORY_START}\n## Memory\n\n${memoryText || ''}${wikiHints ? '\n' + wikiHints + '\n' : '\n'}${MEMORY_END}`;

  let content: string;
  if (fs.existsSync(claudeMdPath)) {
    content = fs.readFileSync(claudeMdPath, 'utf-8');

    // 检查是否已有 Memory section
    const startIdx = content.indexOf(MEMORY_START);
    const endIdx = content.indexOf(MEMORY_END);

    if (startIdx !== -1 && endIdx !== -1) {
      // 替换已有内容
      content =
        content.slice(0, startIdx) +
        memoryBlock +
        content.slice(endIdx + MEMORY_END.length);
    } else {
      // 追加到文件末尾
      content = content.trimEnd() + '\n\n' + memoryBlock + '\n';
    }
  } else {
    content = memoryBlock + '\n';
  }

  fs.writeFileSync(claudeMdPath, content);
  logger.info(
    { groupFolder, factsCount: factsForInjection.length },
    '记忆已注入 CLAUDE.md',
  );
}
