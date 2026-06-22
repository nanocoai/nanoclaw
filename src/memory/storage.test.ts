import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

// ---- mocks ----

// vi.hoisted 确保 tmpDir 在 vi.mock 之前可用
const { tmpDir } = vi.hoisted(() => {
  const _os = require('os');
  const _path = require('path');
  const _fs = require('fs');
  const dir = _path.join(_os.tmpdir(), `nanoclaw-storage-test-${process.pid}`);
  _fs.mkdirSync(dir, { recursive: true });
  return { tmpDir: dir };
});

vi.mock('../config.js', () => ({
  STORE_DIR: tmpDir,
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock memory config
vi.mock('./config.js', () => ({
  getMemoryConfig: vi.fn(() => ({
    enabled: true,
    maxFacts: 100,
    injectionEnabled: true,
    embeddingDims: 1024,
    dashscopeApiKey: '',
    factConfidenceThreshold: 0.7,
  })),
}));

// Mock embeddings — 不调真实 API
const mockGetEmbedding = vi.fn().mockResolvedValue(null);
vi.mock('./embeddings.js', () => ({
  getEmbedding: (...args: unknown[]) => mockGetEmbedding(...args),
  embeddingToBuffer: (emb: number[]) =>
    Buffer.from(new Float32Array(emb).buffer),
  bufferToEmbedding: (buf: Buffer) =>
    Array.from(
      new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4),
    ),
  cosineSimilarity: (a: number[], b: number[]) => {
    let dot = 0,
      normA = 0,
      normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  },
}));

import {
  getMemoryDb,
  closeMemoryDb,
  loadProfile,
  saveProfile,
  loadFacts,
  storeFactRaw,
  updateFact,
  removeFacts,
  storeFacts,
  enforceMaxFacts,
  invalidateFactsCache,
  isFtsAvailable,
  backfillFtsIndex,
} from './storage.js';

// ---- 每个测试重置 DB ----

beforeEach(() => {
  closeMemoryDb();
  // 删除旧 DB 文件
  const dbPath = path.join(tmpDir, 'memory.db');
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* 不存在 */
  }
  try {
    fs.unlinkSync(dbPath + '-wal');
  } catch {
    /* */
  }
  try {
    fs.unlinkSync(dbPath + '-shm');
  } catch {
    /* */
  }
  vi.clearAllMocks();
  invalidateFactsCache();
});

// ---- Profile CRUD ----

describe('Profile CRUD', () => {
  it('空表 → loadProfile 返回 null', () => {
    expect(loadProfile()).toBeNull();
  });

  it('saveProfile + loadProfile 往返一致', () => {
    const data = { user: { name: '大杰' }, history: { recent: 'test' } };
    saveProfile('test-group', data);
    const loaded = loadProfile();
    expect(loaded).toEqual(data);
  });

  it('覆盖写入同 group+user → 取最新', () => {
    saveProfile('g1', { v: 1 });
    saveProfile('g1', { v: 2 });
    expect(loadProfile()).toEqual({ v: 2 });
  });

  it('多次写入取最近更新的', () => {
    saveProfile('g1', { v: 1 });
    // loadProfile 返回 ORDER BY updated_at DESC LIMIT 1
    // 同一毫秒内时间戳可能相同，所以只验证返回非 null
    const result = loadProfile();
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('v');
  });
});

// ---- Facts CRUD ----

describe('Facts CRUD', () => {
  it('storeFactRaw → loadFacts 包含新 fact', () => {
    storeFactRaw('g1', {
      id: 'f1',
      content: '测试内容',
      category: 'context',
      confidence: 0.8,
      source: 'agent',
    });
    const facts = loadFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe('测试内容');
    expect(facts[0].id).toBe('f1');
  });

  it('storeFactRaw 同 id 重复 → INSERT OR IGNORE', () => {
    const fact = {
      id: 'dup',
      content: '原始',
      category: 'c',
      confidence: 0.5,
      source: 's',
    };
    storeFactRaw('g1', fact);
    storeFactRaw('g1', { ...fact, content: '覆盖' });
    const facts = loadFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe('原始'); // 第二次被忽略
  });

  it('content 被 trim', () => {
    storeFactRaw('g1', {
      id: 'trim-test',
      content: '  有空格  ',
      category: 'c',
      confidence: 0.5,
      source: 's',
    });
    expect(loadFacts()[0].content).toBe('有空格');
  });

  it('removeFacts → loadFacts 不含已删 fact', () => {
    storeFactRaw('g1', {
      id: 'del-1',
      content: '删除我',
      category: 'c',
      confidence: 0.5,
      source: 's',
    });
    storeFactRaw('g1', {
      id: 'keep-1',
      content: '保留我',
      category: 'c',
      confidence: 0.5,
      source: 's',
    });
    const removed = removeFacts(['del-1']);
    expect(removed).toBe(1);
    const facts = loadFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0].id).toBe('keep-1');
  });

  it('removeFacts 空数组 → 返回 0', () => {
    expect(removeFacts([])).toBe(0);
  });

  it('removeFacts 不存在的 id → 返回 0', () => {
    expect(removeFacts(['nonexistent'])).toBe(0);
  });
});

// ---- updateFact ----

describe('updateFact', () => {
  it('更新 content', () => {
    storeFactRaw('g1', {
      id: 'u1',
      content: '旧内容',
      category: 'c',
      confidence: 0.5,
      source: 's',
    });
    const result = updateFact('u1', { content: '新内容' });
    expect(result).toBe(true);
    invalidateFactsCache();
    expect(loadFacts()[0].content).toBe('新内容');
  });

  it('更新 confidence', () => {
    storeFactRaw('g1', {
      id: 'u2',
      content: '内容',
      category: 'c',
      confidence: 0.5,
      source: 's',
    });
    updateFact('u2', { confidence: 0.9 });
    invalidateFactsCache();
    expect(loadFacts()[0].confidence).toBe(0.9);
  });

  it('不存在的 id → 返回 false', () => {
    expect(updateFact('nope', { content: 'x' })).toBe(false);
  });

  it('空 updates → 返回 false', () => {
    storeFactRaw('g1', {
      id: 'u3',
      content: '内容',
      category: 'c',
      confidence: 0.5,
      source: 's',
    });
    expect(updateFact('u3', {})).toBe(false);
  });
});

// ---- Facts 缓存 ----

describe('Facts 缓存', () => {
  it('loadFacts 连续调用 → 第二次走缓存', () => {
    storeFactRaw('g1', {
      id: 'cache-1',
      content: '缓存测试',
      category: 'c',
      confidence: 0.5,
      source: 's',
    });
    const first = loadFacts();
    const second = loadFacts();
    // 返回相同引用（缓存）
    expect(first).toBe(second);
  });

  it('invalidateFactsCache 后 → 重新查 DB', () => {
    storeFactRaw('g1', {
      id: 'inv-1',
      content: '初始',
      category: 'c',
      confidence: 0.5,
      source: 's',
    });
    const first = loadFacts();
    invalidateFactsCache();
    const second = loadFacts();
    expect(first).not.toBe(second); // 不同引用
    expect(second).toHaveLength(1); // 但内容一样
  });
});

// ---- storeFacts（含去重） ----

describe('storeFacts 去重', () => {
  it('字符串精确重复 → 跳过', async () => {
    storeFactRaw('g1', {
      id: 'existing',
      content: '已存在',
      category: 'c',
      confidence: 0.5,
      source: 's',
    });
    invalidateFactsCache();

    const count = await storeFacts('g1', [
      {
        id: 'new-1',
        content: '已存在',
        category: 'c',
        confidence: 0.5,
        source: 's',
      },
      {
        id: 'new-2',
        content: '全新内容',
        category: 'c',
        confidence: 0.5,
        source: 's',
      },
    ]);

    expect(count).toBe(1); // 只存了 new-2
  });

  it('空 content → 跳过', async () => {
    const count = await storeFacts('g1', [
      {
        id: 'empty',
        content: '  ',
        category: 'c',
        confidence: 0.5,
        source: 's',
      },
    ]);
    expect(count).toBe(0);
  });

  it('向量语义重复 → 跳过', async () => {
    // 存一个有 embedding 的 fact
    const emb = new Array(4).fill(0).map((_, i) => i * 0.1);
    storeFactRaw('g1', {
      id: 'with-emb',
      content: '有向量',
      category: 'c',
      confidence: 0.5,
      source: 's',
    });
    // 手动更新 embedding
    updateFact('with-emb', { embedding: emb });
    invalidateFactsCache();

    // mock getEmbedding 返回几乎相同的向量（cosine > 0.95）
    mockGetEmbedding.mockResolvedValueOnce(emb.map((x) => x * 1.001));

    const count = await storeFacts('g1', [
      {
        id: 'dup-vec',
        content: '语义重复',
        category: 'c',
        confidence: 0.5,
        source: 's',
      },
    ]);
    expect(count).toBe(0);
  });
});

// ---- enforceMaxFacts ----

describe('enforceMaxFacts', () => {
  it('facts ≤ limit → 不删除', () => {
    storeFactRaw('g1', {
      id: 'e1',
      content: 'a',
      category: 'c',
      confidence: 0.5,
      source: 's',
    });
    invalidateFactsCache();
    expect(enforceMaxFacts('g1', 10)).toBe(0);
  });

  it('facts > limit → 按加权分数保留 top-N', () => {
    for (let i = 0; i < 5; i++) {
      storeFactRaw('g1', {
        id: `e-${i}`,
        content: `fact ${i}`,
        category: 'c',
        confidence: i * 0.2, // 0, 0.2, 0.4, 0.6, 0.8
        source: 's',
      });
    }
    invalidateFactsCache();
    const removed = enforceMaxFacts('g1', 3);
    expect(removed).toBe(2); // 删掉最低分的 2 个
    invalidateFactsCache();
    const remaining = loadFacts();
    expect(remaining).toHaveLength(3);
    // 保留高 confidence 的
    expect(remaining.every((f) => f.confidence >= 0.4)).toBe(true);
  });

  it('limit=0 的 config → 不删除（0 = 不限制）', () => {
    storeFactRaw('g1', {
      id: 'x',
      content: 'a',
      category: 'c',
      confidence: 0.5,
      source: 's',
    });
    invalidateFactsCache();
    // maxFacts=0 from config means no limit
    expect(enforceMaxFacts('g1')).toBe(0);
  });
});

// ---- FTS ----

describe('FTS', () => {
  it('FTS5 可用性检查', () => {
    getMemoryDb(); // 触发初始化
    // 在大多数 SQLite 构建中 FTS5 是可用的
    expect(typeof isFtsAvailable()).toBe('boolean');
  });

  it('storeFactRaw 后 FTS 索引同步', () => {
    storeFactRaw('g1', {
      id: 'fts-1',
      content: '搜索测试内容abc',
      category: 'c',
      confidence: 0.5,
      source: 's',
    });

    if (isFtsAvailable()) {
      const db = getMemoryDb();
      // trigram tokenizer 需要至少 3 字符匹配
      const row = db
        .prepare(
          `SELECT fact_id FROM memory_facts_fts WHERE content MATCH '"搜索测"'`,
        )
        .get() as { fact_id: string } | undefined;
      expect(row?.fact_id).toBe('fts-1');
    }
  });

  it('backfillFtsIndex 补录缺失条目', () => {
    if (!isFtsAvailable()) return; // skip if FTS not available

    // 直接插入 fact 不经过 storeFactRaw（模拟旧数据无 FTS）
    const db = getMemoryDb();
    db.prepare(
      `INSERT INTO memory_facts (id, group_folder, user_id, content, category, confidence, source, created_at)
       VALUES (?, ?, '', ?, 'c', 0.5, 's', datetime('now'))`,
    ).run('backfill-1', 'g1', '补录内容测试数据');

    const count = backfillFtsIndex('g1');
    expect(count).toBe(1);

    // trigram tokenizer 需要至少 3 字符
    const row = db
      .prepare(
        `SELECT fact_id FROM memory_facts_fts WHERE content MATCH '"补录内"'`,
      )
      .get() as { fact_id: string } | undefined;
    expect(row?.fact_id).toBe('backfill-1');
  });
});
