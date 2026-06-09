import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

// ─────────────────────────────────────────────────────────────
// Mock setup — must be before imports
// ─────────────────────────────────────────────────────────────

// Mock config to use test values
vi.mock('../config.js', () => ({
  STORE_DIR: path.join(os.tmpdir(), `nanoclaw-test-${process.pid}`),
}));

// Mock env to return test config
vi.mock('../env.js', () => ({
  readEnvFile: () => ({
    MEMORY_ENABLED: 'true',
    DASHSCOPE_API_KEY: 'test-key',
    MEMORY_DEBOUNCE_SECONDS: '1',
    MEMORY_MAX_FACTS: '10',
    MEMORY_FACT_CONFIDENCE_THRESHOLD: '0.5',
  }),
}));

// Mock logger to suppress output
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// Mock embedding API
vi.mock('./embeddings.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./embeddings.js')>();
  return {
    ...original,
    getEmbedding: vi.fn().mockResolvedValue(null),
  };
});

import { getMemoryConfig, resetMemoryConfig } from './config.js';
import {
  getMemoryDb,
  closeMemoryDb,
  loadProfile,
  saveProfile,
  loadFacts,
  storeFacts,
  removeFacts,
  enforceMaxFacts,
  isFtsAvailable,
  backfillFtsIndex,
} from './storage.js';
import {
  cosineSimilarity,
  embeddingToBuffer,
  bufferToEmbedding,
  getEmbedding,
} from './embeddings.js';
import {
  formatMemoryForInjection,
  formatConversationForUpdate,
  MEMORY_UPDATE_PROMPT,
} from './prompt.js';
import {
  toDecayLambda,
  calculateDecayMultiplier,
  applyTemporalDecay,
  applyDecayToResults,
} from './temporal-decay.js';
import { tokenize, jaccardSimilarity, mmrRerank } from './mmr.js';
import { keywordSearch } from './keyword-store.js';
import { mergeHybridResults } from './hybrid.js';
import { MemoryUpdateQueue } from './queue.js';
import { injectMemory } from './inject.js';
import { STORE_DIR } from '../config.js';

// ─────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = STORE_DIR;
  fs.mkdirSync(tmpDir, { recursive: true });
  resetMemoryConfig();
  closeMemoryDb();
});

afterEach(() => {
  closeMemoryDb();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }
});

// ─────────────────────────────────────────────────────────────
// config 测试
// ─────────────────────────────────────────────────────────────

describe('config', () => {
  it('加载默认配置', () => {
    const config = getMemoryConfig();
    expect(config.enabled).toBe(true);
    expect(config.debounceSeconds).toBe(1);
    expect(config.maxFacts).toBe(10);
    expect(config.factConfidenceThreshold).toBe(0.5);
    expect(config.dashscopeApiKey).toBe('test-key');
    expect(config.embeddingModel).toBe('text-embedding-v4');
    expect(config.llmModel).toBe('qwen3.6-plus');
  });
});

// ─────────────────────────────────────────────────────────────
// storage 测试
// ─────────────────────────────────────────────────────────────

describe('storage', () => {
  it('初始化数据库', () => {
    const db = getMemoryDb();
    expect(db).toBeDefined();
    // 表存在
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'memory_%'",
      )
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('memory_profiles');
    expect(names).toContain('memory_facts');
  });

  describe('profile CRUD', () => {
    it('保存和加载 profile', () => {
      saveProfile('test_group', {
        user: { workContext: { summary: 'Engineer', updatedAt: '' } },
      });
      const loaded = loadProfile();
      expect(loaded).toBeDefined();
      expect(
        (loaded!.user as Record<string, { summary: string }>).workContext
          .summary,
      ).toBe('Engineer');
    });

    it('不存在时返回 null', () => {
      getMemoryDb(); // 初始化（空库，没有任何 profile）
      expect(loadProfile()).toBeNull();
    });

    it('更新已有 profile', () => {
      saveProfile('test_group', { user: { v: 1 } });
      saveProfile('test_group', { user: { v: 2 } });
      const loaded = loadProfile();
      expect((loaded!.user as Record<string, number>).v).toBe(2);
    });
  });

  describe('facts CRUD', () => {
    it('存储和加载 facts', async () => {
      const count = await storeFacts('test_group', [
        {
          id: 'f1',
          content: 'TypeScript expert',
          category: 'knowledge',
          confidence: 0.9,
          source: 'test',
        },
      ]);
      expect(count).toBe(1);
      const facts = loadFacts();
      expect(facts).toHaveLength(1);
      expect(facts[0].content).toBe('TypeScript expert');
      expect(facts[0].category).toBe('knowledge');
    });

    it('字符串精确去重', async () => {
      await storeFacts('test_group', [
        {
          id: 'f1',
          content: 'Same content',
          category: 'context',
          confidence: 0.8,
          source: 'test',
        },
      ]);
      const count = await storeFacts('test_group', [
        {
          id: 'f2',
          content: 'Same content',
          category: 'context',
          confidence: 0.8,
          source: 'test',
        },
      ]);
      expect(count).toBe(0);
    });

    it('removeFacts 删除', async () => {
      await storeFacts('test_group', [
        {
          id: 'f1',
          content: 'To be removed',
          category: 'context',
          confidence: 0.8,
          source: 'test',
        },
      ]);
      const removed = removeFacts(['f1']);
      expect(removed).toBe(1);
      expect(loadFacts()).toHaveLength(0);
    });

    it('enforceMaxFacts 超限清理', async () => {
      const facts = Array.from({ length: 5 }, (_, i) => ({
        id: `f${i}`,
        content: `Fact ${i}`,
        category: 'context',
        confidence: i * 0.2,
        source: 'test',
      }));
      await storeFacts('test_group', facts);
      const removed = enforceMaxFacts('test_group', 3);
      expect(removed).toBe(2);
      const remaining = loadFacts();
      expect(remaining).toHaveLength(3);
      // 高置信度的应该保留
      expect(remaining.map((f) => f.id)).toContain('f4');
      expect(remaining.map((f) => f.id)).toContain('f3');
    });
  });

  describe('FTS', () => {
    it('FTS5 表初始化', () => {
      getMemoryDb();
      // FTS 在某些 SQLite 构建中可能不可用，但测试环境通常支持
      // 如果不可用则跳过
      if (!isFtsAvailable()) return;
      const db = getMemoryDb();
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name = 'memory_facts_fts'",
        )
        .all();
      expect(tables).toHaveLength(1);
    });

    it('backfillFtsIndex 补录', async () => {
      // 先绕过 FTS 直接插入
      const db = getMemoryDb();
      db.prepare(
        'INSERT INTO memory_facts (id, group_folder, user_id, content, category, confidence, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        'bf1',
        'test_group',
        '',
        'Direct insert',
        'context',
        0.8,
        'test',
        new Date().toISOString(),
      );

      const count = backfillFtsIndex('test_group');
      if (isFtsAvailable()) {
        expect(count).toBe(1);
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────
// embeddings 测试
// ─────────────────────────────────────────────────────────────

describe('embeddings', () => {
  it('cosineSimilarity 计算', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
  });

  it('embedding 序列化往返', () => {
    const original = [0.1, 0.2, 0.3, 0.4];
    const buf = embeddingToBuffer(original);
    const restored = bufferToEmbedding(buf);
    expect(restored).toHaveLength(4);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 5);
    }
  });

  it('getEmbedding mock 返回 null', async () => {
    const result = await getEmbedding('test');
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// prompt 测试
// ─────────────────────────────────────────────────────────────

describe('prompt', () => {
  it('MEMORY_UPDATE_PROMPT 存在且包含模板变量', () => {
    expect(MEMORY_UPDATE_PROMPT).toContain('{current_memory}');
    expect(MEMORY_UPDATE_PROMPT).toContain('{conversation}');
  });

  it('MEMORY_UPDATE_PROMPT 明确长期知识与短期流水账边界', () => {
    expect(MEMORY_UPDATE_PROMPT).toContain(
      'knowledge：长期有效、可复用的技术结论',
    );
    expect(MEMORY_UPDATE_PROMPT).toContain('PR 号');
    expect(MEMORY_UPDATE_PROMPT).toContain('commit hash');
    expect(MEMORY_UPDATE_PROMPT).toContain('当前 PID');
    expect(MEMORY_UPDATE_PROMPT).toContain('当前分支脏项');
    expect(MEMORY_UPDATE_PROMPT).toContain(
      '不要记录 AI 自己刚完成了什么',
    );
  });

  it('MEMORY_UPDATE_PROMPT 要求已完成事项不继续写 goal', () => {
    expect(MEMORY_UPDATE_PROMPT).toContain(
      '已完成、已合并、已验证通过、已放弃的事项不能继续写 goal',
    );
  });

  it('MEMORY_UPDATE_PROMPT 对 context 置信度有降权约束', () => {
    expect(MEMORY_UPDATE_PROMPT).toContain('context 通常不超过 0.8');
  });

  describe('formatMemoryForInjection', () => {
    it('格式化完整记忆数据', () => {
      const text = formatMemoryForInjection({
        user: {
          workContext: { summary: 'Engineer at ACME' },
          personalContext: { summary: 'Speaks English' },
        },
        history: {
          recentMonths: { summary: 'Built NanoClaw' },
        },
        facts: [
          {
            content: 'Prefers TypeScript',
            category: 'preference',
            confidence: 0.9,
          },
        ],
      });
      expect(text).toContain('工作: Engineer at ACME');
      expect(text).toContain('个人: Speaks English');
      expect(text).toContain('近期: Built NanoClaw');
      expect(text).toContain('[preference | 0.90] Prefers TypeScript');
    });

    it('空数据返回空字符串', () => {
      expect(formatMemoryForInjection({})).toBe('');
    });

    it('token 预算截断 facts', () => {
      const facts = Array.from({ length: 100 }, (_, i) => ({
        content: `Fact number ${i} with some extra content to take tokens`,
        category: 'context',
        confidence: 0.9,
      }));
      const text = formatMemoryForInjection({ facts }, 100);
      // 应该只包含部分 facts
      expect(text.length).toBeLessThan(600); // ~100 tokens * 4 chars + margin
    });
  });

  describe('formatConversationForUpdate', () => {
    it('格式化用户和 bot 消息', () => {
      const text = formatConversationForUpdate([
        { content: 'Hello', sender_name: 'Alice' },
        { content: 'Hi there', is_bot_message: true },
      ]);
      expect(text).toContain('User (Alice): Hello');
      expect(text).toContain('Assistant: Hi there');
    });

    it('截断过长消息', () => {
      const longContent = 'x'.repeat(2000);
      const text = formatConversationForUpdate([
        { content: longContent, sender_name: 'User' },
      ]);
      expect(text.length).toBeLessThan(1200);
      expect(text).toContain('...');
    });

    it('清除上传文件标签', () => {
      const text = formatConversationForUpdate([
        {
          content:
            '<uploaded_files>/path/to/file</uploaded_files>\nActual message',
          sender_name: 'User',
        },
      ]);
      expect(text).not.toContain('uploaded_files');
      expect(text).toContain('Actual message');
    });

    it('is_from_me 映射为 Assistant', () => {
      const text = formatConversationForUpdate([
        { content: 'My reply', is_from_me: true },
      ]);
      expect(text).toContain('Assistant: My reply');
    });
  });
});

// ─────────────────────────────────────────────────────────────
// temporal-decay 测试
// ─────────────────────────────────────────────────────────────

describe('temporal-decay', () => {
  it('toDecayLambda 计算', () => {
    const lambda = toDecayLambda(30);
    expect(lambda).toBeCloseTo(Math.log(2) / 30, 10);
    expect(toDecayLambda(0)).toBe(0);
    expect(toDecayLambda(-1)).toBe(0);
  });

  it('calculateDecayMultiplier 半衰期验证', () => {
    // 30 天半衰期，30 天后应该约 0.5
    const mult = calculateDecayMultiplier(30, 30);
    expect(mult).toBeCloseTo(0.5, 5);

    // 0 天 → 1.0
    expect(calculateDecayMultiplier(0, 30)).toBe(1);
  });

  it('applyTemporalDecay 对分数衰减', () => {
    const score = applyTemporalDecay(1.0, 30, 30);
    expect(score).toBeCloseTo(0.5, 5);
  });

  it('applyDecayToResults 批量衰减', () => {
    const now = Date.now() / 1000;
    const thirtyDaysAgo = new Date((now - 30 * 86400) * 1000).toISOString();

    const results = applyDecayToResults(
      [
        { id: '1', content: 'old', createdAt: thirtyDaysAgo, score: 1.0 },
        { id: '2', content: 'no-time', score: 1.0 },
      ],
      30,
      now,
    );

    expect(results[0].score).toBeCloseTo(0.5, 1);
    expect(results[1].score).toBe(1.0); // 无时间信息保持原分数
  });
});

// ─────────────────────────────────────────────────────────────
// mmr 测试
// ─────────────────────────────────────────────────────────────

describe('mmr', () => {
  it('tokenize 提取中英文 token', () => {
    const tokens = tokenize('Hello 世界 test123');
    expect(tokens).toContain('hello');
    // 连续中文字符作为一个 token（与 Nine 一致）
    expect(tokens).toContain('世界');
    expect(tokens).toContain('test123');
    expect(tokens.size).toBe(3);
  });

  it('jaccardSimilarity 计算', () => {
    const a = new Set(['a', 'b', 'c']);
    const b = new Set(['b', 'c', 'd']);
    // intersection=2, union=4
    expect(jaccardSimilarity(a, b)).toBeCloseTo(0.5);
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
  });

  it('mmrRerank 多样性重排', () => {
    const items = [
      { id: '1', content: 'TypeScript Node.js', score: 0.9 },
      { id: '2', content: 'TypeScript Node.js React', score: 0.85 },
      { id: '3', content: 'Python Django', score: 0.8 },
    ];
    const result = mmrRerank(items, 0.5);
    // 第一个应该是最高分
    expect(result[0].id).toBe('1');
    // 由于 lambda=0.5 偏向多样性，Python/Django 应该排在重复的 TS 前面
    expect(result[1].id).toBe('3');
    expect(result[2].id).toBe('2');
  });

  it('mmrRerank 单项直接返回', () => {
    const items = [{ id: '1', content: 'Only one', score: 1.0 }];
    const result = mmrRerank(items);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('1');
  });

  it('mmrRerank 使用向量余弦相似度', () => {
    const items = [
      { id: '1', content: 'A', score: 0.9 },
      { id: '2', content: 'B', score: 0.85 },
      { id: '3', content: 'C', score: 0.8 },
    ];
    const embeddings = new Map<string, number[]>();
    embeddings.set('1', [1, 0]);
    embeddings.set('2', [0.99, 0.1]); // 与 1 非常相似
    embeddings.set('3', [0, 1]); // 与 1 很不同

    const result = mmrRerank(items, 0.5, embeddings);
    expect(result[0].id).toBe('1');
    // 3 与 1 不同，应排 2 前面
    expect(result[1].id).toBe('3');
  });
});

// ─────────────────────────────────────────────────────────────
// keyword-store 测试
// ─────────────────────────────────────────────────────────────

describe('keyword-store', () => {
  it('FTS5 或 LIKE 检索', async () => {
    await storeFacts('test_group', [
      {
        id: 'k1',
        content: 'User prefers TypeScript for backend development',
        category: 'preference',
        confidence: 0.9,
        source: 'test',
      },
      {
        id: 'k2',
        content: 'Python is used for data science tasks',
        category: 'knowledge',
        confidence: 0.8,
        source: 'test',
      },
    ]);

    const results = keywordSearch('TypeScript', 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content).toContain('TypeScript');
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('空查询返回空', () => {
    getMemoryDb();
    const results = keywordSearch('', 5);
    expect(results).toHaveLength(0);
  });

  it('整库查（不按 group_folder 和 user_id 过滤）', async () => {
    await storeFacts(
      'group_a',
      [
        {
          id: 'ua1',
          content: 'User A fact about TypeScript',
          category: 'context',
          confidence: 0.8,
          source: 'test',
        },
      ],
      'user_a',
    );
    await storeFacts(
      'group_b',
      [
        {
          id: 'ub1',
          content: 'User B fact about Python',
          category: 'context',
          confidence: 0.8,
          source: 'test',
        },
      ],
      'user_b',
    );

    // 整库查：不管哪个用户/哪个群存的都能查到
    const results = keywordSearch('TypeScript', 5);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('ua1');

    const allResults = keywordSearch('fact', 10);
    expect(allResults).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────
// hybrid 测试
// ─────────────────────────────────────────────────────────────

describe('hybrid', () => {
  it('融合双路结果', () => {
    const vectorResults = [
      {
        id: '1',
        content: 'A',
        score: 0.9,
        createdAt: new Date().toISOString(),
      },
      {
        id: '2',
        content: 'B',
        score: 0.7,
        createdAt: new Date().toISOString(),
      },
    ];
    const keywordResults = [
      {
        id: '2',
        content: 'B',
        score: 0.8,
        createdAt: new Date().toISOString(),
      },
      {
        id: '3',
        content: 'C',
        score: 0.6,
        createdAt: new Date().toISOString(),
      },
    ];

    const merged = mergeHybridResults(vectorResults, keywordResults, {
      mmrLambda: undefined, // 跳过 MMR 简化测试
    });

    expect(merged).toHaveLength(3);
    // id=2 被两路命中，分数应该最高
    const item2 = merged.find((m) => m.id === '2');
    expect(item2).toBeDefined();
    // 0.7*0.7 + 0.3*0.8 = 0.49 + 0.24 = 0.73（衰减前）
    expect(item2!.score).toBeGreaterThan(0);
  });

  it('单路结果也能工作', () => {
    const merged = mergeHybridResults(
      [{ id: '1', content: 'A', score: 0.9 }],
      [],
      { mmrLambda: undefined },
    );
    expect(merged).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────
// queue 测试
// ─────────────────────────────────────────────────────────────

describe('queue', () => {
  it('入队和覆盖', () => {
    const q = new MemoryUpdateQueue();
    q.add('group1', [{ content: 'msg1' }]);
    expect(q.pendingCount).toBe(1);

    q.add('group1', [{ content: 'msg2' }]);
    expect(q.pendingCount).toBe(1); // 覆盖

    q.add('group2', [{ content: 'msg3' }]);
    expect(q.pendingCount).toBe(2);

    q.clear();
    expect(q.pendingCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// inject 测试
// ─────────────────────────────────────────────────────────────

describe('inject', () => {
  let testGroupDir: string;

  beforeEach(() => {
    testGroupDir = path.join(
      os.tmpdir(),
      `nanoclaw-inject-${process.pid}-${Date.now()}`,
    );
    fs.mkdirSync(testGroupDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(testGroupDir, { recursive: true, force: true });
    } catch {
      // 忽略
    }
  });

  it('创建新 CLAUDE.md 并注入', async () => {
    saveProfile('inject_test', {
      user: { workContext: { summary: 'Test engineer' } },
    });

    await injectMemory('inject_test', testGroupDir);

    const content = fs.readFileSync(
      path.join(testGroupDir, 'CLAUDE.md'),
      'utf-8',
    );
    expect(content).toContain('<!-- nanoclaw:memory:start -->');
    expect(content).toContain('<!-- nanoclaw:memory:end -->');
    expect(content).toContain('Test engineer');
  });

  it('追加到已有 CLAUDE.md', async () => {
    fs.writeFileSync(
      path.join(testGroupDir, 'CLAUDE.md'),
      '# My Group\n\nExisting content.\n',
    );
    saveProfile('inject_test2', {
      user: { workContext: { summary: 'Appended' } },
    });

    await injectMemory('inject_test2', testGroupDir);

    const content = fs.readFileSync(
      path.join(testGroupDir, 'CLAUDE.md'),
      'utf-8',
    );
    expect(content).toContain('# My Group');
    expect(content).toContain('Existing content.');
    expect(content).toContain('Appended');
  });

  it('替换已有 Memory section', async () => {
    const initial =
      '# Group\n\n<!-- nanoclaw:memory:start -->\n## Memory\n\nOld stuff\n<!-- nanoclaw:memory:end -->\n\n# Footer\n';
    fs.writeFileSync(path.join(testGroupDir, 'CLAUDE.md'), initial);

    saveProfile('inject_test3', {
      user: { workContext: { summary: 'New stuff' } },
    });

    await injectMemory('inject_test3', testGroupDir);

    const content = fs.readFileSync(
      path.join(testGroupDir, 'CLAUDE.md'),
      'utf-8',
    );
    expect(content).not.toContain('Old stuff');
    expect(content).toContain('New stuff');
    expect(content).toContain('# Footer');
  });

  it('空记忆不注入', async () => {
    getMemoryDb(); // 初始化
    await injectMemory('empty_group', testGroupDir);
    expect(fs.existsSync(path.join(testGroupDir, 'CLAUDE.md'))).toBe(false);
  });
});
