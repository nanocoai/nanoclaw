import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  cleanContent,
  isToolCallNoiseContent,
  estimateTokens,
  generateChunkId,
  chunkConversation,
  ChatIndex,
  resetChatIndex,
} from './chat-index.js';
import { _initTestDatabase, getDb } from './db.js';

// --- 禁用 CHAT_INDEX_ENABLED mock ---
vi.mock('./config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config.js')>();
  return {
    ...actual,
    CHAT_INDEX_ENABLED: true,
    CHAT_INDEX_DEBOUNCE_MS: 50, // 测试中用短 debounce
    QDRANT_URL: 'http://localhost:6333',
  };
});

// --- mock embedding 为固定向量 ---
vi.mock('./memory/embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Array(1024).fill(0.1)),
}));

beforeEach(() => {
  _initTestDatabase();
  resetChatIndex();
});

// ==================== cleanContent ====================

describe('cleanContent', () => {
  it('移除 <internal> 标签', () => {
    const input = '前面<internal>这是内部思考</internal>后面';
    expect(cleanContent(input)).toBe('前面后面');
  });

  it('将 tool_result 简化为 [工具: name]', () => {
    const input =
      '<tool_result><tool_name>Read</tool_name>内容很长很长</tool_result>';
    expect(cleanContent(input)).toBe('[工具: Read]');
  });

  it('将无 tool_name 的 tool_result 简化', () => {
    const input = '<tool_result>一些结果</tool_result>';
    expect(cleanContent(input)).toBe('[工具调用结果]');
  });

  it('将 tool_use 简化为 [使用工具: name]', () => {
    const input =
      '<tool_use><tool_name>Bash</tool_name>{"command":"ls"}</tool_use>';
    expect(cleanContent(input)).toBe('[使用工具: Bash]');
  });

  it('处理空字符串', () => {
    expect(cleanContent('')).toBe('');
    expect(cleanContent(null as unknown as string)).toBe('');
  });

  it('保留普通文本不变', () => {
    const input = '这是一段普通文本，包含 code 和 123';
    expect(cleanContent(input)).toBe(input);
  });
});

describe('isToolCallNoiseContent', () => {
  it('识别助手纯工具调用 chunk', () => {
    expect(isToolCallNoiseContent('用户: 查一下\n助手: 🔧 Bash: ls -la')).toBe(
      true,
    );
    expect(isToolCallNoiseContent('用户: 查一下\n助手: [使用工具: Bash]')).toBe(
      true,
    );
  });

  it('普通结果不是工具噪音', () => {
    expect(
      isToolCallNoiseContent('用户: 查一下\n助手: 已查完，结果是 3 个文件'),
    ).toBe(false);
  });
});

// ==================== estimateTokens ====================

describe('estimateTokens', () => {
  it('中文字符每个约 1 token', () => {
    expect(estimateTokens('你好世界')).toBe(4);
  });

  it('英文按空格分词', () => {
    expect(estimateTokens('hello world')).toBe(2);
  });

  it('混合中英文', () => {
    const tokens = estimateTokens('你好 hello 世界');
    expect(tokens).toBeGreaterThanOrEqual(4); // 你好 + hello + 世界
  });

  it('空字符串返回 0', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(null as unknown as string)).toBe(0);
  });
});

// ==================== generateChunkId ====================

describe('generateChunkId', () => {
  it('生成 32 位十六进制字符串', () => {
    const id = generateChunkId('group1', 'chat@jid', ['msg1', 'msg2']);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('相同输入产生相同 ID（确定性）', () => {
    const a = generateChunkId('g', 'c', ['m1', 'm2']);
    const b = generateChunkId('g', 'c', ['m1', 'm2']);
    expect(a).toBe(b);
  });

  it('message_ids 顺序不影响结果', () => {
    const a = generateChunkId('g', 'c', ['m1', 'm2']);
    const b = generateChunkId('g', 'c', ['m2', 'm1']);
    expect(a).toBe(b);
  });

  it('不同输入产生不同 ID', () => {
    const a = generateChunkId('g1', 'c', ['m1']);
    const b = generateChunkId('g2', 'c', ['m1']);
    expect(a).not.toBe(b);
  });
});

// ==================== chunkConversation ====================

describe('chunkConversation', () => {
  const baseMeta = {
    chat_jid: 'test@jid',
    group_folder: 'test_group',
    userMsgId: 'u1',
    botMsgId: 'b1',
    sender_name: '张三',
    timestamp: '2024-01-01T00:00:00Z',
  };

  it('短对话生成单个 chunk', () => {
    const chunks = chunkConversation(
      '你好',
      '你好，有什么可以帮你？',
      baseMeta,
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunk_text).toContain('张三: 你好');
    expect(chunks[0].chunk_text).toContain('助手: 你好，有什么可以帮你？');
    expect(chunks[0].group_folder).toBe('test_group');
    expect(chunks[0].qdrant_indexed).toBe(0);
  });

  it('空内容不生成 chunk', () => {
    const chunks = chunkConversation('', '', baseMeta);
    expect(chunks).toHaveLength(0);
  });

  it('清理 internal 标签后生成 chunk', () => {
    const chunks = chunkConversation(
      '帮我看下',
      '<internal>thinking...</internal>看完了，没问题',
      baseMeta,
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunk_text).not.toContain('thinking');
    expect(chunks[0].chunk_text).toContain('看完了，没问题');
  });

  it('超长内容分多个 chunk', () => {
    const longText = '这是一段很长的文字。'.repeat(200); // ~1200 中文字符
    const chunks = chunkConversation(longText, '好的', baseMeta);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('chunk ID 幂等', () => {
    const a = chunkConversation('问题', '回答', baseMeta);
    const b = chunkConversation('问题', '回答', baseMeta);
    expect(a[0].id).toBe(b[0].id);
  });

  it('message_ids 包含用户和 bot 消息 ID', () => {
    const chunks = chunkConversation('问', '答', baseMeta);
    const ids = JSON.parse(chunks[0].message_ids);
    expect(ids).toContain('u1');
    expect(ids).toContain('b1');
  });
});

// ==================== ChatIndex SQLite 部分 ====================

describe('ChatIndex SQLite 操作', () => {
  it('enqueue + batchIndex 写入 SQLite chat_chunks', async () => {
    const idx = new ChatIndex();
    // 不 init（跳过 Qdrant），直接 enqueue + batchIndex
    idx.enqueue({
      userContent: '什么是 TypeScript？',
      botContent: 'TypeScript 是 JavaScript 的超集...',
      userMsgId: 'msg_u1',
      botMsgId: 'msg_b1',
      chat_jid: 'test@jid',
      group_folder: 'test_grp',
      sender_name: '用户A',
      timestamp: '2024-06-01T10:00:00Z',
    });

    // 手动调用 batchIndex（绕过 debounce）
    await idx.batchIndex();

    const db = getDb();
    const rows = db
      .prepare('SELECT * FROM chat_chunks WHERE group_folder = ?')
      .all('test_grp') as Array<{ id: string; chunk_text: string }>;

    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].chunk_text).toContain('TypeScript');
  });

  it('幂等写入：重复 enqueue 不创建重复 chunk', async () => {
    const idx = new ChatIndex();
    const item = {
      userContent: '重复测试',
      botContent: '回复重复测试',
      userMsgId: 'dup_u1',
      botMsgId: 'dup_b1',
      chat_jid: 'test@jid',
      group_folder: 'dup_grp',
      sender_name: '用户',
      timestamp: '2024-06-01T10:00:00Z',
    };

    idx.enqueue(item);
    await idx.batchIndex();
    idx.enqueue(item);
    await idx.batchIndex();

    const db = getDb();
    const count = db
      .prepare('SELECT COUNT(*) as cnt FROM chat_chunks WHERE group_folder = ?')
      .get('dup_grp') as { cnt: number };

    expect(count.cnt).toBe(1);
  });

  it('FTS5 索引可搜索', async () => {
    const idx = new ChatIndex();
    idx.enqueue({
      userContent: '飞书文档怎么用？',
      botContent: '飞书文档支持多人协作编辑',
      userMsgId: 'fts_u1',
      botMsgId: 'fts_b1',
      chat_jid: 'test@jid',
      group_folder: 'fts_grp',
      sender_name: '用户',
      timestamp: '2024-06-01T10:00:00Z',
    });
    await idx.batchIndex();

    const db = getDb();
    // trigram 至少 3 字符
    const rows = db
      .prepare(
        `SELECT c.chunk_text FROM chat_chunks_fts fts
         JOIN chat_chunks c ON c.rowid = fts.rowid
         WHERE chat_chunks_fts MATCH '飞书文档'`,
      )
      .all() as Array<{ chunk_text: string }>;

    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].chunk_text).toContain('飞书文档');
  });

  it('FTS5 trigram < 3 字符无法匹配', async () => {
    const idx = new ChatIndex();
    idx.enqueue({
      userContent: '你好',
      botContent: '你好呀',
      userMsgId: 'tri_u1',
      botMsgId: 'tri_b1',
      chat_jid: 'test@jid',
      group_folder: 'tri_grp',
      sender_name: '用户',
      timestamp: '2024-06-01T10:00:00Z',
    });
    await idx.batchIndex();

    const db = getDb();
    // "你好" 只有 2 个中文字符（6 bytes），trigram 分词可能不匹配
    // 但实际上 trigram 是按 byte 的，中文 UTF-8 每字 3 bytes，"你好" = 6 bytes = 2 trigrams
    // 这里测试少于 3 字符的英文查询
    const rows = db
      .prepare(
        `SELECT c.chunk_text FROM chat_chunks_fts fts
         JOIN chat_chunks c ON c.rowid = fts.rowid
         WHERE chat_chunks_fts MATCH 'ab'`,
      )
      .all();

    // "ab" 只有 2 字节，trigram 无法匹配
    expect(rows.length).toBe(0);
  });

  it('dispose 刷新剩余队列', async () => {
    const idx = new ChatIndex();
    idx.enqueue({
      userContent: '关闭前的消息',
      botContent: '会被 flush',
      userMsgId: 'dis_u1',
      botMsgId: 'dis_b1',
      chat_jid: 'test@jid',
      group_folder: 'dis_grp',
      sender_name: '用户',
      timestamp: '2024-06-01T10:00:00Z',
    });

    // 不等 debounce，直接 dispose
    await idx.dispose();

    const db = getDb();
    const rows = db
      .prepare('SELECT * FROM chat_chunks WHERE group_folder = ?')
      .all('dis_grp');

    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('FTS5 特殊字符不会导致崩溃', async () => {
    const idx = new ChatIndex();
    idx.enqueue({
      userContent: '搜索 "双引号" 和 OR AND 等特殊字符',
      botContent: '这些不应该让 FTS5 崩溃',
      userMsgId: 'special_u1',
      botMsgId: 'special_b1',
      chat_jid: 'test@jid',
      group_folder: 'special_grp',
      sender_name: '用户',
      timestamp: '2024-06-01T10:00:00Z',
    });
    await idx.batchIndex();

    // search 方法内部会转义这些字符
    const results = await idx.search('"OR" AND * NOT');
    // 不崩溃就算通过
    expect(Array.isArray(results)).toBe(true);
  });

  it('search 默认过滤纯工具调用 chunk，includeToolCalls=true 返回全量', async () => {
    const idx = new ChatIndex();
    idx.enqueue({
      userContent: '统计文件数量',
      botContent: '🔧 Bash: find . -type f | wc -l',
      userMsgId: 'tool_u1',
      botMsgId: 'tool_b1',
      chat_jid: 'test@jid',
      group_folder: 'tool_noise_grp',
      sender_name: '用户',
      timestamp: '2024-06-01T10:00:00Z',
    });
    await idx.batchIndex();

    const filtered = await idx.search('统计文件数量');
    const all = await idx.search('统计文件数量', { includeToolCalls: true });

    expect(filtered).toHaveLength(0);
    expect(all.length).toBeGreaterThanOrEqual(1);
  });

  it('bot 回复失败不阻塞（空内容不入库）', () => {
    const chunks = chunkConversation('问题', '', {
      chat_jid: 'test@jid',
      group_folder: 'fail_grp',
      userMsgId: 'fail_u1',
      botMsgId: 'fail_b1',
      sender_name: '用户',
      timestamp: '2024-06-01T10:00:00Z',
    });
    // bot 回复为空时，fullText 仍可能有用户部分
    // 验证不会 crash
    expect(Array.isArray(chunks)).toBe(true);
  });
});
