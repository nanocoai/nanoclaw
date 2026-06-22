/**
 * 聊天记录索引模块 — Qdrant 向量 + SQLite FTS5 双路索引和检索
 */
import crypto from 'crypto';

import { QdrantClient } from '@qdrant/js-client-rest';

import {
  CHAT_INDEX_DEBOUNCE_MS,
  CHAT_INDEX_ENABLED,
  QDRANT_URL,
} from './config.js';
import { getDb } from './db.js';
import { logger } from './logger.js';
import { getEmbedding } from './memory/embeddings.js';
import { mergeHybridResults, HybridResult } from './memory/hybrid.js';

// --- 类型定义 ---

export interface ChatChunk {
  id: string;
  chat_jid: string;
  group_folder: string;
  message_ids: string; // JSON array
  chunk_text: string;
  sender_names: string;
  start_time: string;
  end_time: string;
  qdrant_indexed: number;
}

export interface EnqueueItem {
  userContent: string;
  botContent: string;
  userMsgId: string;
  botMsgId: string;
  chat_jid: string;
  group_folder: string;
  sender_name: string;
  timestamp: string;
}

export interface SearchOptions {
  group?: string; // group_folder 过滤
  sender?: string; // sender_names 过滤
  days?: number; // 最近 N 天（与 startTime/endTime 互斥，后者优先）
  startTime?: string; // ISO 8601 起始时间
  endTime?: string; // ISO 8601 截止时间
  limit?: number; // 返回条数，默认 10
  includeToolCalls?: boolean; // 是否返回纯工具调用 chunk，默认 false
}

export interface SearchResult {
  chunk_text: string;
  score: number;
  group_folder: string;
  chat_jid: string;
  sender_names: string;
  time_range: string;
  start_time: string;
  end_time: string;
  message_count: number;
}

// --- 常量 ---

const COLLECTION_NAME = 'chat_chunks';
const VECTOR_SIZE = 1024;
const MAX_CHUNK_TOKENS = 500;
const OVERLAP_TOKENS = 100;
const RETRY_LIMIT = 100;

// --- 噪声过滤 ---

/** 清理消息内容：去掉 tool_result、internal 标签 */
export function cleanContent(text: string): string {
  if (!text) return '';
  let cleaned = text;
  // 移除 <internal>...</internal>
  cleaned = cleaned.replace(/<internal>[\s\S]*?<\/internal>/g, '');
  // tool_result 丢弃内容，仅保留工具名
  cleaned = cleaned.replace(
    /<tool_result>\s*<tool_name>(.*?)<\/tool_name>[\s\S]*?<\/tool_result>/g,
    '[工具: $1]',
  );
  // 通用 tool_result 清理（没有 tool_name 子标签的情况）
  cleaned = cleaned.replace(
    /<tool_result>[\s\S]*?<\/tool_result>/g,
    '[工具调用结果]',
  );
  // tool_use 只保留工具名
  cleaned = cleaned.replace(
    /<tool_use>\s*<tool_name>(.*?)<\/tool_name>[\s\S]*?<\/tool_use>/g,
    '[使用工具: $1]',
  );
  return cleaned.trim();
}

const TOOL_PROGRESS_PREFIXES = [
  '🔧',
  '📖',
  '✏️',
  '📝',
  '🔍',
  '🌐',
  '💻',
  '⚙️',
  '🧰',
  '📁',
  '📄',
  '🗂️',
  '🛠️',
];

export function isToolCallNoiseContent(text: string): boolean {
  if (!text) return false;
  const assistantLines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('助手:'))
    .map((line) => line.replace(/^助手:\s*/, '').trim())
    .filter(Boolean);

  if (assistantLines.length === 0) return false;

  return assistantLines.every(
    (line) =>
      /^\[(?:使用工具|工具|工具调用结果)(?::[^\]]*)?\]$/.test(line) ||
      TOOL_PROGRESS_PREFIXES.some((prefix) => line.startsWith(prefix)),
  );
}

// --- 分块逻辑 ---

/** 粗估 token 数（中文按字符，英文按空格分词） */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // 中文字符每个约 1 token，英文按空格分词
  let count = 0;
  const segments = text.split(/(\s+)/);
  for (const seg of segments) {
    if (/^[\s]+$/.test(seg)) continue;
    // 计算中文字符数
    const cjk = seg.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g);
    if (cjk) {
      count += cjk.length;
      // 剩余非中文按 1 token
      const remaining = seg.replace(
        /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g,
        '',
      );
      if (remaining.trim()) count += 1;
    } else {
      count += 1;
    }
  }
  return count;
}

/** 生成确定性 chunk ID */
export function generateChunkId(
  groupFolder: string,
  chatJid: string,
  messageIds: string[],
): string {
  const sorted = [...messageIds].sort();
  const input = groupFolder + chatJid + sorted.join(',');
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 32);
}

/** 将对话轮次分块，超长截断 + 重叠 */
export function chunkConversation(
  userContent: string,
  botContent: string,
  metadata: {
    chat_jid: string;
    group_folder: string;
    userMsgId: string;
    botMsgId: string;
    sender_name: string;
    timestamp: string;
  },
): ChatChunk[] {
  const cleanUser = cleanContent(userContent);
  const cleanBot = cleanContent(botContent);
  const fullText = `${metadata.sender_name}: ${cleanUser}\n助手: ${cleanBot}`;

  if (
    !fullText.trim() ||
    fullText.trim() === `${metadata.sender_name}: \n助手:`
  ) {
    return [];
  }

  const tokens = estimateTokens(fullText);
  const messageIds = [metadata.userMsgId, metadata.botMsgId];

  if (tokens <= MAX_CHUNK_TOKENS) {
    // 单个 chunk
    const id = generateChunkId(
      metadata.group_folder,
      metadata.chat_jid,
      messageIds,
    );
    return [
      {
        id,
        chat_jid: metadata.chat_jid,
        group_folder: metadata.group_folder,
        message_ids: JSON.stringify(messageIds),
        chunk_text: fullText,
        sender_names: metadata.sender_name,
        start_time: metadata.timestamp,
        end_time: metadata.timestamp,
        qdrant_indexed: 0,
      },
    ];
  }

  // 超长截断 + 重叠
  const chunks: ChatChunk[] = [];
  const words = fullText.split('');
  let pos = 0;
  let chunkIdx = 0;

  while (pos < words.length) {
    const end = Math.min(pos + MAX_CHUNK_TOKENS, words.length);
    const chunkText = words.slice(pos, end).join('');

    if (chunkText.trim()) {
      const chunkMsgIds = [...messageIds, `chunk_${chunkIdx}`];
      const id = generateChunkId(
        metadata.group_folder,
        metadata.chat_jid,
        chunkMsgIds,
      );
      chunks.push({
        id,
        chat_jid: metadata.chat_jid,
        group_folder: metadata.group_folder,
        message_ids: JSON.stringify(messageIds),
        chunk_text: chunkText,
        sender_names: metadata.sender_name,
        start_time: metadata.timestamp,
        end_time: metadata.timestamp,
        qdrant_indexed: 0,
      });
    }

    const nextPos = end - OVERLAP_TOKENS;
    // 确保前进（避免死循环），且第一个 chunk 不回退到负数
    pos = nextPos > pos ? nextPos : end;
    chunkIdx++;

    // 防止最后一个 chunk 太小（< 50 tokens）
    if (words.length - pos < 50 && pos < words.length) {
      // 合并到当前 chunk
      break;
    }
  }

  return chunks;
}

// --- ChatIndex 类 ---

export class ChatIndex {
  private qdrant: QdrantClient | null = null;
  private qdrantAvailable = false;
  private queue: EnqueueItem[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private indexing = false;
  private disposed = false;

  /** 初始化：连接 Qdrant，创建 collection，重试未索引 chunk */
  async init(): Promise<void> {
    if (!CHAT_INDEX_ENABLED) {
      logger.debug('Chat index disabled (CHAT_INDEX_ENABLED=false)');
      return;
    }

    // 连接 Qdrant
    try {
      this.qdrant = new QdrantClient({ url: QDRANT_URL, timeout: 5000 });
      // Health check + 获取 collections
      const collections = await this.qdrant.getCollections();
      this.qdrantAvailable = true;
      logger.info({ url: QDRANT_URL }, 'Qdrant 连接成功');

      // 创建 collection（如不存在）
      const exists = collections.collections.some(
        (c) => c.name === COLLECTION_NAME,
      );
      if (!exists) {
        await this.qdrant.createCollection(COLLECTION_NAME, {
          vectors: { size: VECTOR_SIZE, distance: 'Cosine' },
        });
        logger.info('创建 Qdrant collection: chat_chunks');
      }
    } catch (err) {
      this.qdrantAvailable = false;
      logger.warn({ err }, 'Qdrant 连接失败，降级为 FTS5-only 模式');
    }

    // 启动时重试未索引的 chunk
    await this.retryUnindexed();
  }

  /** 扫描 qdrant_indexed=0 的 chunk，重新索引 */
  async retryUnindexed(): Promise<void> {
    if (!this.qdrantAvailable || !this.qdrant) return;

    try {
      const db = getDb();
      const chunks = db
        .prepare('SELECT * FROM chat_chunks WHERE qdrant_indexed = 0 LIMIT ?')
        .all(RETRY_LIMIT) as ChatChunk[];

      if (chunks.length === 0) return;
      logger.info({ count: chunks.length }, '重试未索引的 chat chunks');

      for (const chunk of chunks) {
        try {
          const embedding = await getEmbedding(chunk.chunk_text);
          if (!embedding) continue;

          if (embedding.length !== VECTOR_SIZE) {
            logger.error(
              {
                expected: VECTOR_SIZE,
                got: embedding.length,
                chunkId: chunk.id,
              },
              'Embedding 维度不匹配，跳过',
            );
            continue;
          }

          await this.qdrant!.upsert(COLLECTION_NAME, {
            points: [
              {
                id: chunk.id,
                vector: embedding,
                payload: {
                  chat_jid: chunk.chat_jid,
                  group_folder: chunk.group_folder,
                  sender_names: chunk.sender_names,
                  start_time: chunk.start_time,
                  chunk_text: chunk.chunk_text,
                },
              },
            ],
          });

          db.prepare(
            'UPDATE chat_chunks SET qdrant_indexed = 1 WHERE id = ?',
          ).run(chunk.id);
        } catch (err) {
          logger.warn({ err, chunkId: chunk.id }, '重试索引 chunk 失败');
        }
      }
    } catch (err) {
      logger.warn({ err }, '扫描未索引 chunk 失败');
    }
  }

  /** 入队新消息用于索引 */
  enqueue(item: EnqueueItem): void {
    if (!CHAT_INDEX_ENABLED) return;
    logger.info(
      { group: item.group_folder, queueLen: this.queue.length + 1 },
      'chatIndex.enqueue: 消息入队',
    );
    this.queue.push(item);
    this.scheduleIndex();
  }

  /** 防抖调度 */
  private scheduleIndex(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.runBatchIndex();
    }, CHAT_INDEX_DEBOUNCE_MS);
  }

  /** 串行执行 batchIndex（互斥锁） */
  private async runBatchIndex(): Promise<void> {
    if (this.indexing) {
      // 当前批次还在执行，等它完了再来
      this.scheduleIndex();
      return;
    }
    this.indexing = true;
    try {
      await this.batchIndex();
    } finally {
      this.indexing = false;
    }
  }

  /** 批量索引队列中的消息 */
  async batchIndex(): Promise<void> {
    if (this.queue.length === 0) return;

    const items = [...this.queue];
    this.queue = [];
    logger.info({ count: items.length }, 'chatIndex.batchIndex: 开始批量索引');

    const db = getDb();

    for (const item of items) {
      try {
        const chunks = chunkConversation(item.userContent, item.botContent, {
          chat_jid: item.chat_jid,
          group_folder: item.group_folder,
          userMsgId: item.userMsgId,
          botMsgId: item.botMsgId,
          sender_name: item.sender_name,
          timestamp: item.timestamp,
        });

        for (const chunk of chunks) {
          // 幂等写入 SQLite
          db.prepare(
            `INSERT OR IGNORE INTO chat_chunks
             (id, chat_jid, group_folder, message_ids, chunk_text, sender_names, start_time, end_time, qdrant_indexed)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            chunk.id,
            chunk.chat_jid,
            chunk.group_folder,
            chunk.message_ids,
            chunk.chunk_text,
            chunk.sender_names,
            chunk.start_time,
            chunk.end_time,
            0,
          );

          // Qdrant 索引
          if (this.qdrantAvailable && this.qdrant) {
            try {
              const embedding = await getEmbedding(chunk.chunk_text);
              if (!embedding) continue;

              if (embedding.length !== VECTOR_SIZE) {
                logger.error(
                  {
                    expected: VECTOR_SIZE,
                    got: embedding.length,
                    chunkId: chunk.id,
                  },
                  'Embedding 维度不匹配，跳过',
                );
                continue;
              }

              await this.qdrant.upsert(COLLECTION_NAME, {
                points: [
                  {
                    id: chunk.id,
                    vector: embedding,
                    payload: {
                      chat_jid: chunk.chat_jid,
                      group_folder: chunk.group_folder,
                      sender_names: chunk.sender_names,
                      start_time: chunk.start_time,
                      chunk_text: chunk.chunk_text,
                    },
                  },
                ],
              });

              db.prepare(
                'UPDATE chat_chunks SET qdrant_indexed = 1 WHERE id = ?',
              ).run(chunk.id);
            } catch (err) {
              logger.warn(
                { err, chunkId: chunk.id },
                'Qdrant upsert 失败，保留 FTS5',
              );
            }
          }
        }
      } catch (err) {
        logger.warn({ err }, '索引消息失败');
      }
    }
  }

  /** 双路检索 */
  async search(
    query: string,
    options: SearchOptions = {},
  ): Promise<SearchResult[]> {
    const limit = options.limit || 10;
    const overFetch = limit * 3; // 过采样用于融合

    // --- Qdrant 向量检索 ---
    let vectorResults: HybridResult[] = [];
    if (this.qdrantAvailable && this.qdrant) {
      try {
        const queryEmbedding = await getEmbedding(query);
        if (queryEmbedding) {
          // 构造过滤条件
          const must: Array<Record<string, unknown>> = [];
          if (options.group) {
            must.push({
              key: 'group_folder',
              match: { value: options.group },
            });
          }
          // 时间过滤：startTime/endTime 优先于 days
          if (options.startTime || options.endTime) {
            const range: Record<string, string> = {};
            if (options.startTime) range.gte = options.startTime;
            if (options.endTime) range.lte = options.endTime;
            must.push({ key: 'start_time', range });
          } else if (options.days) {
            const since = new Date(
              Date.now() - options.days * 86400000,
            ).toISOString();
            must.push({
              key: 'start_time',
              range: { gte: since },
            });
          }

          const filter = must.length > 0 ? { must } : undefined;
          const results = await this.qdrant.search(COLLECTION_NAME, {
            vector: queryEmbedding,
            limit: overFetch,
            with_payload: true,
            with_vector: true,
            filter,
          });

          vectorResults = results.map((r) => ({
            id: String(r.id),
            content: String(
              (r.payload as Record<string, unknown>)?.chunk_text || '',
            ),
            score: r.score,
            createdAt: String(
              (r.payload as Record<string, unknown>)?.start_time || '',
            ),
            embedding: Array.isArray(r.vector)
              ? (r.vector as number[])
              : undefined,
            metadata: r.payload as Record<string, unknown>,
          }));
        }
      } catch (err) {
        logger.warn({ err }, 'Qdrant 检索失败，降级为 FTS5-only');
      }
    }

    // --- FTS5 关键词检索 ---
    let keywordResults: HybridResult[] = [];
    try {
      const db = getDb();
      let sql = `
        SELECT c.id, c.chunk_text, c.group_folder, c.chat_jid, c.sender_names, c.start_time, c.end_time,
               c.message_ids, bm25(chat_chunks_fts) as bm25_score
        FROM chat_chunks_fts fts
        JOIN chat_chunks c ON c.rowid = fts.rowid
        WHERE chat_chunks_fts MATCH ?
      `;
      // FTS5 trigram: 转义双引号，用引号包裹防止 OR/AND/* 等语法字符被解析
      const safeQuery = '"' + query.replace(/"/g, '""') + '"';
      const params: unknown[] = [safeQuery];

      if (options.group) {
        sql += ' AND c.group_folder = ?';
        params.push(options.group);
      }
      // 时间过滤：startTime/endTime 优先于 days
      if (options.startTime || options.endTime) {
        if (options.startTime) {
          sql += ' AND c.start_time >= ?';
          params.push(options.startTime);
        }
        if (options.endTime) {
          sql += ' AND c.end_time <= ?';
          params.push(options.endTime);
        }
      } else if (options.days) {
        const since = new Date(
          Date.now() - options.days * 86400000,
        ).toISOString();
        sql += ' AND c.start_time >= ?';
        params.push(since);
      }

      sql += ' ORDER BY bm25_score LIMIT ?';
      params.push(overFetch);

      const rows = db.prepare(sql).all(...params) as Array<{
        id: string;
        chunk_text: string;
        group_folder: string;
        chat_jid: string;
        sender_names: string;
        start_time: string;
        end_time: string;
        message_ids: string;
        bm25_score: number;
      }>;

      keywordResults = rows.map((r) => ({
        id: r.id,
        content: r.chunk_text,
        score: Math.abs(r.bm25_score), // FTS5 bm25() 返回负数
        createdAt: r.start_time,
        metadata: {
          group_folder: r.group_folder,
          chat_jid: r.chat_jid,
          sender_names: r.sender_names,
          start_time: r.start_time,
          end_time: r.end_time,
          message_ids: r.message_ids,
        },
      }));
    } catch (err) {
      logger.warn({ err }, 'FTS5 检索失败');
    }

    // --- 融合排序 ---
    const skipMmr = !this.qdrantAvailable || vectorResults.length === 0;
    const merged = mergeHybridResults(vectorResults, keywordResults, {
      vectorWeight: 0.7,
      textWeight: 0.3,
      temporalDecayHalfLife: 90,
      mmrLambda: skipMmr ? undefined : 0.7,
    });

    // sender 过滤（应用层）
    let filtered = merged;
    if (!options.includeToolCalls) {
      filtered = filtered.filter((r) => !isToolCallNoiseContent(r.content));
    }
    if (options.sender) {
      const senderLower = options.sender.toLowerCase();
      filtered = filtered.filter((r) => {
        const names = String(
          (r.metadata as Record<string, unknown>)?.sender_names || '',
        ).toLowerCase();
        return names.includes(senderLower);
      });
    }

    // 取 top-K 并格式化
    return filtered.slice(0, limit).map((r) => {
      const meta = (r.metadata || {}) as Record<string, unknown>;
      const messageIds = meta.message_ids
        ? JSON.parse(String(meta.message_ids))
        : [];
      const startTime = String(meta.start_time || '');
      const endTime = String(meta.end_time || '');
      return {
        chunk_text: r.content,
        score: r.score,
        group_folder: String(meta.group_folder || ''),
        chat_jid: String(meta.chat_jid || ''),
        sender_names: String(meta.sender_names || ''),
        time_range: `${startTime} ~ ${endTime}`,
        start_time: startTime,
        end_time: endTime,
        message_count: Array.isArray(messageIds) ? messageIds.length : 0,
      };
    });
  }

  /** 关闭时 flush 剩余队列 */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    // flush 剩余
    if (this.queue.length > 0) {
      await this.batchIndex();
    }
  }

  /** 获取 Qdrant 可用状态（测试用） */
  isQdrantAvailable(): boolean {
    return this.qdrantAvailable;
  }
}

// --- 单例 ---

let _instance: ChatIndex | null = null;

export function getChatIndex(): ChatIndex {
  if (!_instance) {
    _instance = new ChatIndex();
  }
  return _instance;
}

export function resetChatIndex(): void {
  _instance = null;
}
