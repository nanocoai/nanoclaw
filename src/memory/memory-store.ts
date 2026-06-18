/**
 * 统一记忆存储接口 — 从 Nine store.py 翻译
 *
 * 封装向量 + 关键词双路检索。
 * 跨群共享：recall 只按 user_id 查，store 仍保留 groupFolder 溯源。
 */
import { getEmbedding, cosineSimilarity } from './embeddings.js';
import { keywordSearch } from './keyword-store.js';
import { mergeHybridResults, HybridResult } from './hybrid.js';
import { loadFacts, storeFacts as storeFactsToDb } from './storage.js';
import { logger } from '../logger.js';

export class MemoryStore {
  private groupFolder: string;
  private userId: string;

  // 单例实例
  private static _instance: MemoryStore | null = null;

  /**
   * 获取单例实例（热路径用，避免每条消息实例化）
   */
  static getInstance(): MemoryStore {
    if (!MemoryStore._instance) {
      MemoryStore._instance = new MemoryStore();
    }
    return MemoryStore._instance;
  }

  constructor(userId: string = '', groupFolder: string = '') {
    this.groupFolder = groupFolder;
    this.userId = userId;
  }

  /**
   * 双路召回：向量近邻 + 关键词 → 融合 → 时间衰减 → MMR → top-K
   */
  async recall(query: string, topK: number = 5): Promise<HybridResult[]> {
    // 1. 向量检索（暴力 cosine）
    const vectorResults: HybridResult[] = [];
    const queryEmbedding = await getEmbedding(query);

    if (queryEmbedding) {
      try {
        const facts = loadFacts();
        const scored: Array<{ fact: (typeof facts)[0]; score: number }> = [];

        for (const fact of facts) {
          if (!fact.embedding) continue;
          const sim = cosineSimilarity(queryEmbedding, fact.embedding);
          scored.push({ fact, score: sim });
        }

        // 排序取 top-K*2（多取用于后续融合截取）
        scored.sort((a, b) => b.score - a.score);
        const topN = scored.slice(0, topK * 2);

        for (const { fact, score } of topN) {
          vectorResults.push({
            id: fact.id,
            content: fact.content,
            metadata: { category: fact.category },
            createdAt: fact.createdAt,
            score,
            // W3 修复：携带 embedding 传给 MMR
            embedding: fact.embedding || undefined,
          });
        }
      } catch (err) {
        logger.warn({ err }, '向量检索失败');
      }
    }

    // 2. 关键词检索
    let keywordResults: HybridResult[] = [];
    try {
      const kwResults = keywordSearch(query, topK * 2);
      keywordResults = kwResults.map((r) => ({
        id: r.id,
        content: r.content,
        metadata: r.metadata,
        createdAt: r.createdAt,
        score: r.score,
      }));
    } catch (err) {
      logger.warn({ err }, '关键词检索失败');
    }

    // 3. 双路融合
    const merged = mergeHybridResults(vectorResults, keywordResults, {
      vectorWeight: 0.7,
      textWeight: 0.3,
      temporalDecayHalfLife: 30,
      mmrLambda: 0.7,
    });

    // 4. 分数阈值过滤：无相关记忆时（话题无关）不再硬塞 topK 条噪声进 prompt。
    // 实测分布（5899 facts × 20 条真实消息）：
    //   0.30: 日常消息平均召回 1.7 条噪音，精确率 64%
    //   0.42: 技术消息保持 4.6/5，日常噪音降至 0.3 条，精确率 73%
    //   0.45: 技术消息降至 4.1/5，开始丢有效结果
    // 甜区 0.42：过滤"收到/好的/看下这个"等日常噪音，保住技术召回。
    const threshold = Number(process.env.MEMORY_RECALL_THRESHOLD ?? 0.42);
    const filtered = merged.filter((m) => (m.score ?? 0) >= threshold);

    return filtered.slice(0, topK);
  }

  /**
   * 存储一条记忆到 SQLite + FTS5 + embedding
   */
  async store(
    content: string,
    metadata?: { category?: string; confidence?: number; source?: string },
  ): Promise<string | null> {
    const id = crypto.randomUUID();
    const stored = await storeFactsToDb(
      this.groupFolder,
      [
        {
          id,
          content,
          category: metadata?.category || 'context',
          confidence: metadata?.confidence ?? 0.5,
          source: metadata?.source || 'unknown',
        },
      ],
      this.userId,
    );
    return stored > 0 ? id : null;
  }
}
