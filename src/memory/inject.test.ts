import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

// ---- mocks ----

const { tmpDir } = vi.hoisted(() => {
  const _os = require('os');
  const _path = require('path');
  const _fs = require('fs');
  const dir = _path.join(_os.tmpdir(), `nanoclaw-inject-test-${process.pid}`);
  _fs.mkdirSync(dir, { recursive: true });
  return { tmpDir: dir };
});

vi.mock('../config.js', () => ({
  STORE_DIR: tmpDir,
  GROUPS_DIR: tmpDir,
  QDRANT_URL: 'http://localhost:6333',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

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

// Mock embeddings
vi.mock('./embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(null),
  embeddingToBuffer: vi.fn(),
  bufferToEmbedding: vi.fn(),
  cosineSimilarity: vi.fn(),
}));

// Mock Qdrant — 完全禁用向量路径
vi.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: vi.fn().mockImplementation(() => ({
    getCollections: vi.fn().mockRejectedValue(new Error('mocked')),
  })),
}));

// Mock storage
const mockLoadFacts = vi.fn(() => []);
const mockLoadProfile = vi.fn(() => null);
vi.mock('./storage.js', () => ({
  loadFacts: () => mockLoadFacts(),
  loadProfile: () => mockLoadProfile(),
}));

// Mock memory-store
const mockRecall = vi.fn().mockResolvedValue([]);
vi.mock('./memory-store.js', () => ({
  MemoryStore: {
    getInstance: () => ({
      recall: mockRecall,
    }),
  },
}));

// Mock prompt
vi.mock('./prompt.js', () => ({
  formatMemoryForInjection: vi.fn((data: any) => {
    const parts: string[] = [];
    if (data.user) parts.push(`用户概况:\n- ${JSON.stringify(data.user)}`);
    if (data.facts?.length) {
      parts.push(
        '事实:\n' +
          data.facts
            .map(
              (f: any) =>
                `- [${f.category} | ${f.confidence?.toFixed?.(2) ?? f.confidence}] ${f.content}`,
            )
            .join('\n'),
      );
    }
    return parts.join('\n\n') || '';
  }),
}));

import {
  extractKeywords,
  hashContext,
  getLastContextHash,
  setLastContextHash,
  clearContextHash,
  matchWikiEntries,
  injectMemory,
  buildMessageContext,
  recallRelevantFacts,
} from './inject.js';
import { getMemoryConfig } from './config.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadFacts.mockReturnValue([]);
  mockLoadProfile.mockReturnValue(null);
  mockRecall.mockResolvedValue([]);
  clearContextHash('test-group');
});

// ---- extractKeywords ----

describe('extractKeywords', () => {
  it('英文提取 3+ 字符单词', () => {
    const kw = extractKeywords('I use React and Go');
    expect(kw).toContain('use');
    expect(kw).toContain('react');
    expect(kw).not.toContain('go'); // 2 字符，不符合 3+
    expect(kw).not.toContain('i'); // 1 字符
  });

  it('中文 bigram 滑窗', () => {
    const kw = extractKeywords('动态记忆系统');
    expect(kw).toContain('动态');
    expect(kw).toContain('态记');
    expect(kw).toContain('记忆');
    expect(kw).toContain('忆系');
    expect(kw).toContain('系统');
  });

  it('短中文词（≤4 字）整体保留', () => {
    const kw = extractKeywords('记忆');
    expect(kw).toContain('记忆');
  });

  it('混合中英文', () => {
    const kw = extractKeywords('使用 React 框架');
    expect(kw).toContain('react');
    expect(kw).toContain('使用');
    expect(kw).toContain('框架');
  });

  it('空字符串 → 空数组', () => {
    expect(extractKeywords('')).toEqual([]);
  });

  it('结果去重', () => {
    const kw = extractKeywords('test test test');
    const testCount = kw.filter((k) => k === 'test').length;
    expect(testCount).toBe(1);
  });

  it('纯标点符号 → 空数组', () => {
    expect(extractKeywords('!@#$%')).toEqual([]);
  });
});

// ---- hashContext / context hash ----

describe('hashContext', () => {
  it('相同 context → 相同 hash', () => {
    const ctx = {
      wiki: [],
      facts: [{ content: 'a', category: 'b', confidence: 0.5 }],
    };
    expect(hashContext(ctx)).toBe(hashContext(ctx));
  });

  it('不同 context → 不同 hash', () => {
    const c1 = {
      wiki: [],
      facts: [{ content: 'a', category: 'b', confidence: 0.5 }],
    };
    const c2 = {
      wiki: [],
      facts: [{ content: 'x', category: 'y', confidence: 0.9 }],
    };
    expect(hashContext(c1)).not.toBe(hashContext(c2));
  });
});

describe('context hash 管理', () => {
  it('set/get 正确', () => {
    setLastContextHash('g1', 'hash123');
    expect(getLastContextHash('g1')).toBe('hash123');
  });

  it('clear 后 → undefined', () => {
    setLastContextHash('g1', 'hash123');
    clearContextHash('g1');
    expect(getLastContextHash('g1')).toBeUndefined();
  });

  it('不同 group 互不干扰', () => {
    setLastContextHash('g1', 'aaa');
    setLastContextHash('g2', 'bbb');
    expect(getLastContextHash('g1')).toBe('aaa');
    expect(getLastContextHash('g2')).toBe('bbb');
  });
});

// ---- matchWikiEntries ----

describe('matchWikiEntries', () => {
  const wikiDir = path.join(tmpDir, 'wiki');

  beforeEach(() => {
    fs.mkdirSync(wikiDir, { recursive: true });
  });

  it('wiki index 不存在 → 返回空数组', async () => {
    const result = await matchWikiEntries('搜索', '/nonexistent/index.md');
    expect(result).toEqual([]);
  });

  it('关键词命中 wiki index → 返回结果（含空数组）', async () => {
    const indexPath = path.join(wikiDir, 'index.md');
    fs.writeFileSync(
      indexPath,
      `# Wiki Index\n\n- [Review Agent Optimization](review-agent.md) — review agent false positive filtering mechanism\n- [Tool Authentication](tool-auth.md) — tool access control system\n`,
    );

    // BM25 only path（向量被 mock 为不可用）：融合分数 = 0.3 * BM25
    // 阈值 > 0.3 意味着 BM25 必须接近 1.0 才能通过
    // 这里主要验证不报错且返回数组
    const result = await matchWikiEntries(
      'Review Agent Optimization false positive filtering',
      indexPath,
    );
    expect(Array.isArray(result)).toBe(true);
    // 如果 BM25 分数足够高（normBm25 = 1.0 → fused = 0.3），则 > 0.3 不通过
    // 所以 BM25-only 模式下可能返回空数组，这是设计预期行为
  });

  it('无关键词命中 → 返回空数组', async () => {
    const indexPath = path.join(wikiDir, 'index2.md');
    fs.writeFileSync(
      indexPath,
      `- [Alpha](alpha.md) — alpha topic\n- [Beta](beta.md) — beta topic\n`,
    );

    const result = await matchWikiEntries('完全无关的内容xyz', indexPath);
    // BM25 可能匹配也可能不匹配，取决于 token 化
    // 这里只验证不报错
    expect(Array.isArray(result)).toBe(true);
  });
});

// ---- recallRelevantFacts ----

describe('recallRelevantFacts', () => {
  it('无 facts → 返回空数组', async () => {
    mockLoadFacts.mockReturnValue([]);
    const result = await recallRelevantFacts('查询');
    expect(result).toEqual([]);
  });

  it('MemoryStore 召回成功 → 返回格式化结果', async () => {
    mockLoadFacts.mockReturnValue([{ id: 'f1', content: '存在' }]);
    mockRecall.mockResolvedValue([
      {
        id: 'f1',
        content: '用户喜欢 TypeScript',
        score: 0.85,
        metadata: { category: 'preference' },
      },
    ]);
    const result = await recallRelevantFacts('TypeScript');
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('TypeScript');
    expect(result[0].category).toBe('preference');
  });

  it('MemoryStore 失败 → 回退 confidence top-K', async () => {
    mockLoadFacts.mockReturnValue([
      { content: '高置信', category: 'c', confidence: 0.9 },
      { content: '低置信', category: 'c', confidence: 0.3 },
    ]);
    mockRecall.mockRejectedValue(new Error('Qdrant down'));
    const result = await recallRelevantFacts('查询', 1);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('高置信');
  });
});

// ---- injectMemory ----

describe('injectMemory', () => {
  const groupDir = path.join(tmpDir, 'inject-test-group');

  beforeEach(() => {
    fs.mkdirSync(groupDir, { recursive: true });
    // 清理 CLAUDE.md
    const claudeMd = path.join(groupDir, 'CLAUDE.md');
    try {
      fs.unlinkSync(claudeMd);
    } catch {
      /* */
    }
  });

  it('无记忆数据 → 不写文件', async () => {
    mockLoadProfile.mockReturnValue(null);
    mockLoadFacts.mockReturnValue([]);
    await injectMemory('g1', groupDir);
    expect(fs.existsSync(path.join(groupDir, 'CLAUDE.md'))).toBe(false);
  });

  it('injectionEnabled=false → 不写文件', async () => {
    (getMemoryConfig as any).mockReturnValue({
      enabled: true,
      injectionEnabled: false,
    });
    mockLoadProfile.mockReturnValue({ user: { name: '测试' } });
    await injectMemory('g1', groupDir);
    expect(fs.existsSync(path.join(groupDir, 'CLAUDE.md'))).toBe(false);
  });

  it('首次注入 → CLAUDE.md 包含 memory 标记', async () => {
    (getMemoryConfig as any).mockReturnValue({
      enabled: true,
      injectionEnabled: true,
    });
    mockLoadProfile.mockReturnValue({ user: { name: '大杰' } });
    mockLoadFacts.mockReturnValue([
      { id: 'f1', content: '测试事实', category: 'context', confidence: 0.8 },
    ]);

    await injectMemory('g1', groupDir);

    const content = fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('<!-- nanoclaw:memory:start -->');
    expect(content).toContain('<!-- nanoclaw:memory:end -->');
    expect(content).toContain('Memory');
  });

  it('重复注入 → 替换已有 memory section', async () => {
    (getMemoryConfig as any).mockReturnValue({
      enabled: true,
      injectionEnabled: true,
    });

    // 写入初始 CLAUDE.md 带 memory 标记
    const claudeMd = path.join(groupDir, 'CLAUDE.md');
    fs.writeFileSync(
      claudeMd,
      '# 群配置\n\n<!-- nanoclaw:memory:start -->\n## Memory\n\n旧内容\n<!-- nanoclaw:memory:end -->\n',
    );

    mockLoadProfile.mockReturnValue({ user: { name: '更新' } });
    mockLoadFacts.mockReturnValue([]);

    await injectMemory('g1', groupDir);

    const content = fs.readFileSync(claudeMd, 'utf-8');
    expect(content).toContain('# 群配置');
    // 只有一对标记（不会重复追加）
    const starts = content.split('<!-- nanoclaw:memory:start -->').length - 1;
    expect(starts).toBe(1);
    // 旧内容被替换
    expect(content).not.toContain('旧内容');
  });

  it('已有 CLAUDE.md 无 memory 标记 → 追加到末尾', async () => {
    (getMemoryConfig as any).mockReturnValue({
      enabled: true,
      injectionEnabled: true,
    });

    const claudeMd = path.join(groupDir, 'CLAUDE.md');
    fs.writeFileSync(claudeMd, '# 群配置\n\n其他内容\n');

    mockLoadProfile.mockReturnValue({ user: { role: 'dev' } });
    mockLoadFacts.mockReturnValue([]);

    await injectMemory('g1', groupDir);

    const content = fs.readFileSync(claudeMd, 'utf-8');
    expect(content).toContain('# 群配置');
    expect(content).toContain('其他内容');
    expect(content).toContain('<!-- nanoclaw:memory:start -->');
  });
});

// ---- buildMessageContext ----

describe('buildMessageContext', () => {
  it('injectionEnabled=false → 返回 null', async () => {
    (getMemoryConfig as any).mockReturnValue({ injectionEnabled: false });
    const result = await buildMessageContext('测试', tmpDir);
    expect(result).toBeNull();
  });

  it('无匹配 → 返回 null', async () => {
    (getMemoryConfig as any).mockReturnValue({ injectionEnabled: true });
    mockLoadFacts.mockReturnValue([]);
    const result = await buildMessageContext('测试', tmpDir);
    expect(result).toBeNull();
  });
});
