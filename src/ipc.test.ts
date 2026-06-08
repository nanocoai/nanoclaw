import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

// ---- mocks ----

const { tmpDir } = vi.hoisted(() => {
  const _os = require('os');
  const _path = require('path');
  const _fs = require('fs');
  const dir = _path.join(_os.tmpdir(), `nanoclaw-ipc-test-${process.pid}`);
  _fs.mkdirSync(dir, { recursive: true });
  return { tmpDir: dir };
});

vi.mock('./config.js', () => ({
  DATA_DIR: tmpDir,
  GROUPS_DIR: tmpDir,
  IPC_POLL_INTERVAL: 100,
  TIMEZONE: 'UTC',
  CHAT_INDEX_ENABLED: false,
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./chat-index.js', () => ({
  getChatIndex: vi.fn(() => ({
    search: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('./container-runner.js', () => ({
  getFeishuToken: vi.fn().mockResolvedValue('mock-token'),
}));

const mockCreateTask = vi.fn();
const mockDeleteTask = vi.fn();
const mockGetTaskById = vi.fn();
const mockUpdateTask = vi.fn();
const mockGetMessageContext = vi.fn();
const mockGetMessageContextById = vi.fn();
const mockGetMessageRange = vi.fn();
const mockClampRangeParams = vi.fn();

vi.mock('./db.js', () => ({
  createTask: (...args: unknown[]) => mockCreateTask(...args),
  deleteTask: (...args: unknown[]) => mockDeleteTask(...args),
  getTaskById: (...args: unknown[]) => mockGetTaskById(...args),
  updateTask: (...args: unknown[]) => mockUpdateTask(...args),
  storeMessageDirect: vi.fn(),
  getMessageContext: (...args: unknown[]) => mockGetMessageContext(...args),
  getMessageContextById: (...args: unknown[]) => mockGetMessageContextById(...args),
  getMessageRange: (...args: unknown[]) => mockGetMessageRange(...args),
  clampRangeParams: (...args: unknown[]) => mockClampRangeParams(...args),
}));

vi.mock('./group-folder.js', () => ({
  isValidGroupFolder: (f: string) => !f.includes('..') && !f.includes('/'),
}));

const { mockIsMemoryEnabled } = vi.hoisted(() => ({
  mockIsMemoryEnabled: vi.fn(() => true),
}));
vi.mock('./memory/index.js', () => ({
  isMemoryEnabled: () => mockIsMemoryEnabled(),
}));

const mockRecall = vi.fn().mockResolvedValue([]);
vi.mock('./memory/memory-store.js', () => ({
  MemoryStore: {
    getInstance: () => ({ recall: mockRecall }),
  },
}));

const { mockStoreFactRaw, mockExtractAndRefine } = vi.hoisted(() => ({
  mockStoreFactRaw: vi.fn(),
  mockExtractAndRefine: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./memory/storage.js', () => ({
  loadFacts: vi.fn(() => []),
  storeFactRaw: (...args: unknown[]) => mockStoreFactRaw(...args),
}));

vi.mock('./memory/extract-fact.js', () => ({
  extractAndRefine: (...args: unknown[]) => mockExtractAndRefine(...args),
}));

import { writeIpcResponse, processTaskIpc, isDuplicateMessage, recentMessages, IpcDeps } from './ipc.js';
import type { RegisteredGroup } from './types.js';

// ---- helpers ----

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main', folder: 'main_group', trigger: 'always',
  added_at: '2024-01-01', isMain: true,
};
const OTHER_GROUP: RegisteredGroup = {
  name: 'Other', folder: 'other_group', trigger: '@bot',
  added_at: '2024-01-01',
};

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks 会清除 mock 实现，需要重新设置默认值
  mockIsMemoryEnabled.mockReturnValue(true);
  mockExtractAndRefine.mockResolvedValue(undefined);
  fs.mkdirSync(tmpDir, { recursive: true });

  groups = {
    'fs:oc_main': MAIN_GROUP,
    'fs:oc_other': OTHER_GROUP,
  };

  deps = {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    registeredGroups: () => groups,
    registerGroup: vi.fn((jid, g) => { groups[jid] = g; }),
    syncGroups: vi.fn().mockResolvedValue(undefined),
    getAvailableGroups: vi.fn(() => []),
    writeGroupsSnapshot: vi.fn(),
    onTasksChanged: vi.fn(),
    renameChat: vi.fn().mockResolvedValue(undefined),
    onFeishuAuthRequest: vi.fn().mockResolvedValue(undefined),
  };

  mockGetMessageContext.mockReturnValue({ before: [], anchor: null, after: [] });
  mockGetMessageContextById.mockReturnValue({ before: [], anchor: null, after: [] });
  mockGetMessageRange.mockReturnValue([]);
  mockClampRangeParams.mockImplementation((offset?: number, limit?: number) => ({
    offset: Math.max(0, Math.floor(offset ?? 0)),
    limit: Math.min(200, Math.max(1, Math.floor(limit ?? 20))),
  }));
});

// ---- writeIpcResponse ----

describe('writeIpcResponse', () => {
  it('原子写入：先写 .tmp 再 rename', () => {
    writeIpcResponse('test-group', 'req-1', { result: 'ok' });
    const responsesDir = path.join(tmpDir, 'ipc', 'test-group', 'responses');
    const filePath = path.join(responsesDir, 'req-1.json');
    expect(fs.existsSync(filePath)).toBe(true);
    // .tmp 不应残留
    expect(fs.existsSync(`${filePath}.tmp`)).toBe(false);
    // 内容正确
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(data.result).toBe('ok');
  });

  it('目录不存在时自动创建', () => {
    const subDir = `new-group-${Date.now()}`;
    writeIpcResponse(subDir, 'req-2', { data: 123 });
    const filePath = path.join(tmpDir, 'ipc', subDir, 'responses', 'req-2.json');
    expect(fs.existsSync(filePath)).toBe(true);
  });
});

// ---- processTaskIpc: update_task ----

describe('processTaskIpc - update_task', () => {
  it('更新 prompt → 调用 updateTask', async () => {
    mockGetTaskById.mockReturnValue({
      id: 'task-1', group_folder: 'main_group', prompt: '旧',
      schedule_type: 'once', schedule_value: '2025-01-01',
    });

    await processTaskIpc(
      { type: 'update_task', taskId: 'task-1', prompt: '新 prompt' },
      'main_group', true, deps,
    );

    expect(mockUpdateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({ prompt: '新 prompt' }));
    expect(deps.onTasksChanged).toHaveBeenCalled();
  });

  it('任务不存在 → 不调用 updateTask', async () => {
    mockGetTaskById.mockReturnValue(undefined);
    await processTaskIpc(
      { type: 'update_task', taskId: 'nope', prompt: 'x' },
      'main_group', true, deps,
    );
    expect(mockUpdateTask).not.toHaveBeenCalled();
  });

  it('非 main group 更新别组任务 → 被阻止', async () => {
    mockGetTaskById.mockReturnValue({
      id: 'task-1', group_folder: 'main_group', prompt: '旧',
      schedule_type: 'once', schedule_value: '2025-01-01',
    });

    await processTaskIpc(
      { type: 'update_task', taskId: 'task-1', prompt: '篡改' },
      'other_group', false, deps,
    );

    expect(mockUpdateTask).not.toHaveBeenCalled();
  });
});

// ---- processTaskIpc: memory_recall ----

describe('processTaskIpc - memory_recall', () => {
  it('有 query → 走 MemoryStore.recall + 写 response', async () => {
    mockRecall.mockResolvedValue([
      { id: 'm1', content: '记忆内容', score: 0.9, metadata: { category: 'context' }, createdAt: '2024-01-01' },
    ]);

    await processTaskIpc(
      { type: 'memory_recall', requestId: 'req-recall', query: '搜索' },
      'main_group', true, deps,
    );

    // 验证 response 文件
    const filePath = path.join(tmpDir, 'ipc', 'main_group', 'responses', 'req-recall.json');
    expect(fs.existsSync(filePath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(data.facts).toHaveLength(1);
    expect(data.facts[0].content).toBe('记忆内容');
  });

  it('memory 未启用 → 返回 error', async () => {
    mockIsMemoryEnabled.mockReturnValue(false);

    await processTaskIpc(
      { type: 'memory_recall', requestId: 'req-disabled', query: '搜索' },
      'main_group', true, deps,
    );

    const filePath = path.join(tmpDir, 'ipc', 'main_group', 'responses', 'req-disabled.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(data.error).toContain('disabled');
  });

  it('缺少 requestId → 不写 response', async () => {
    await processTaskIpc(
      { type: 'memory_recall', query: '搜索' },
      'main_group', true, deps,
    );
    // 不应该崩溃，也不写文件
  });
});

// ---- processTaskIpc: memory_remember ----

describe('processTaskIpc - memory_remember', () => {
  it('有 content → 存储 + 异步精炼', async () => {
    await processTaskIpc(
      { type: 'memory_remember', content: '重要记忆', senderId: 'user-1' },
      'main_group', true, deps,
    );

    expect(mockStoreFactRaw).toHaveBeenCalled();
    expect(mockExtractAndRefine).toHaveBeenCalled();
  });

  it('缺少 content → 不存储', async () => {
    await processTaskIpc(
      { type: 'memory_remember' },
      'main_group', true, deps,
    );

    expect(mockStoreFactRaw).not.toHaveBeenCalled();
  });

  it('memory 未启用 → 跳过', async () => {
    mockIsMemoryEnabled.mockReturnValue(false);

    await processTaskIpc(
      { type: 'memory_remember', content: '应该被忽略' },
      'main_group', true, deps,
    );

    expect(mockStoreFactRaw).not.toHaveBeenCalled();
  });
});

// ---- processTaskIpc: get_feishu_token ----

describe('processTaskIpc - get_feishu_token', () => {
  it('成功获取 token → 写 response', async () => {
    await processTaskIpc(
      { type: 'get_feishu_token', requestId: 'req-token', chatJid: 'fs:oc_main', senderId: 'user-1' },
      'main_group', true, deps,
    );

    const filePath = path.join(tmpDir, 'ipc', 'main_group', 'responses', 'req-token.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(data.token).toBe('mock-token');
    expect(data.error).toBeNull();
  });

  it('缺少 requestId → 不写 response', async () => {
    await processTaskIpc(
      { type: 'get_feishu_token', chatJid: 'fs:oc_main' },
      'main_group', true, deps,
    );
    // 不应该崩溃
  });
});

// ---- processTaskIpc: rename_chat (message type, tested via processTaskIpc) ----
// 注意：rename_chat 在 startIpcWatcher 中处理，不是 processTaskIpc。
// 但 refresh_groups 是 processTaskIpc 的一部分。

describe('processTaskIpc - refresh_groups', () => {
  it('main group → 触发 syncGroups', async () => {
    await processTaskIpc(
      { type: 'refresh_groups' },
      'main_group', true, deps,
    );

    expect(deps.syncGroups).toHaveBeenCalledWith(true);
    expect(deps.writeGroupsSnapshot).toHaveBeenCalled();
  });

  it('非 main group → 被阻止', async () => {
    await processTaskIpc(
      { type: 'refresh_groups' },
      'other_group', false, deps,
    );

    expect(deps.syncGroups).not.toHaveBeenCalled();
  });
});

// ---- unknown type ----

describe('processTaskIpc - unknown type', () => {
  it('未知类型 → 不崩溃，记 warn', async () => {
    await processTaskIpc(
      { type: 'nonexistent_type' },
      'main_group', true, deps,
    );
    // 只要不抛异常就好
  });
});

// ---- isDuplicateMessage ----

describe('isDuplicateMessage', () => {
  beforeEach(() => {
    recentMessages.clear();
  });

  it('首次消息 → 不重复', () => {
    expect(isDuplicateMessage('jid1', 'hello')).toBe(false);
  });

  it('30 秒内相同消息 → 重复', () => {
    isDuplicateMessage('jid1', 'hello');
    expect(isDuplicateMessage('jid1', 'hello')).toBe(true);
  });

  it('不同 JID 的相同内容 → 不重复', () => {
    isDuplicateMessage('jid1', 'hello');
    expect(isDuplicateMessage('jid2', 'hello')).toBe(false);
  });

  it('相同 JID 的不同内容 → 不重复', () => {
    isDuplicateMessage('jid1', 'hello');
    expect(isDuplicateMessage('jid1', 'world')).toBe(false);
  });

  it('过期条目被清理', () => {
    // 手动设一条过期条目
    const key = 'jid1:' + require('crypto').createHash('md5').update('old').digest('hex');
    recentMessages.set(key, Date.now() - 60_000); // 60 秒前
    isDuplicateMessage('jid1', 'new'); // 触发清理
    expect(recentMessages.has(key)).toBe(false);
  });

  it('超过 1000 条时全部清空', () => {
    for (let i = 0; i < 1001; i++) {
      recentMessages.set(`key-${i}`, Date.now());
    }
    isDuplicateMessage('jid1', 'trigger-cleanup');
    // 清空后只有刚加的一条
    expect(recentMessages.size).toBe(1);
  });
});

// ---- processTaskIpc: get_chat_context ----

describe('processTaskIpc - get_chat_context', () => {
  it('默认过滤工具调用记录', async () => {
    mockGetMessageContext.mockReturnValue({
      before: [],
      anchor: { sender_name: 'Bob', content: '锚点', timestamp: '2024-01-01T00:01:00Z', is_from_me: true },
      after: [],
    });

    await processTaskIpc(
      {
        type: 'get_chat_context',
        requestId: 'req-context-filtered',
        chat_jid: 'group@g.us',
        timestamp: '2024-01-01T00:01:00Z',
        before: 2,
        after: 4,
      } as unknown as Parameters<typeof processTaskIpc>[0],
      'main_group', true, deps,
    );

    expect(mockGetMessageContext).toHaveBeenCalledWith('group@g.us', '2024-01-01T00:01:00Z', 2, 4, false);
  });

  it('include_tool_calls=true → 查询全量上下文', async () => {
    await processTaskIpc(
      {
        type: 'get_chat_context',
        requestId: 'req-context-all',
        chat_jid: 'group@g.us',
        timestamp: '2024-01-01T00:01:00Z',
        include_tool_calls: true,
      } as unknown as Parameters<typeof processTaskIpc>[0],
      'main_group', true, deps,
    );

    expect(mockGetMessageContext).toHaveBeenCalledWith('group@g.us', '2024-01-01T00:01:00Z', 5, 5, true);
  });
});

// ---- processTaskIpc: get_message_by_id ----

describe('processTaskIpc - get_message_by_id', () => {
  it('有 message_id → 调 getMessageContextById 并写 response', async () => {
    mockGetMessageContextById.mockReturnValue({
      before: [{ sender_name: 'Alice', content: '前', timestamp: '2024-01-01T00:00:00Z', is_from_me: false }],
      anchor: { sender_name: 'Bob', content: '锚点', timestamp: '2024-01-01T00:01:00Z', is_from_me: true },
      after: [],
    });

    await processTaskIpc(
      { type: 'get_message_by_id', requestId: 'req-byid-1' } as Parameters<typeof processTaskIpc>[0],
      'main_group', true, deps,
    );

    // 先补 message_id 字段（processTaskIpc 用 data as Record<string, unknown> 读）
    const dataWithId = { type: 'get_message_by_id', requestId: 'req-byid-2', message_id: 'msg-abc', before: 3, after: 3 } as unknown as Parameters<typeof processTaskIpc>[0];
    await processTaskIpc(dataWithId, 'main_group', true, deps);

    const filePath = path.join(tmpDir, 'ipc', 'main_group', 'responses', 'req-byid-2.json');
    expect(fs.existsSync(filePath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(data.anchor.content).toBe('锚点');
    expect(mockGetMessageContextById).toHaveBeenCalledWith('msg-abc', 3, 3, false);
  });

  it('include_tool_calls=true → 按 ID 查询全量上下文', async () => {
    const dataWithId = {
      type: 'get_message_by_id',
      requestId: 'req-byid-all',
      message_id: 'msg-abc',
      include_tool_calls: true,
    } as unknown as Parameters<typeof processTaskIpc>[0];

    await processTaskIpc(dataWithId, 'main_group', true, deps);

    expect(mockGetMessageContextById).toHaveBeenCalledWith('msg-abc', 5, 5, true);
  });

  it('缺 message_id → error response', async () => {
    await processTaskIpc(
      { type: 'get_message_by_id', requestId: 'req-byid-err' } as Parameters<typeof processTaskIpc>[0],
      'main_group', true, deps,
    );

    const filePath = path.join(tmpDir, 'ipc', 'main_group', 'responses', 'req-byid-err.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(data.error).toContain('message_id');
  });

  it('缺 requestId → 不写 response', async () => {
    await processTaskIpc(
      { type: 'get_message_by_id' } as Parameters<typeof processTaskIpc>[0],
      'main_group', true, deps,
    );
    // 不崩溃即可
  });
});

// ---- processTaskIpc: get_message_range ----

describe('processTaskIpc - get_message_range', () => {
  it('有 chat_jid → clamp + 调 getMessageRange + 写 response', async () => {
    mockGetMessageRange.mockReturnValue([
      { sender_name: 'Alice', content: '消息1', timestamp: '2024-01-01T00:00:00Z', is_from_me: false },
    ]);

    const dataWithJid = { type: 'get_message_range', requestId: 'req-range-1', chat_jid: 'group@g.us', offset: 0, limit: 10 } as unknown as Parameters<typeof processTaskIpc>[0];
    await processTaskIpc(dataWithJid, 'main_group', true, deps);

    const filePath = path.join(tmpDir, 'ipc', 'main_group', 'responses', 'req-range-1.json');
    expect(fs.existsSync(filePath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].content).toBe('消息1');
    expect(mockClampRangeParams).toHaveBeenCalledWith(0, 10);
    expect(mockGetMessageRange).toHaveBeenCalledWith('group@g.us', 0, 10, false);
  });

  it('include_tool_calls=true → 区间查询全量消息', async () => {
    const dataWithJid = {
      type: 'get_message_range',
      requestId: 'req-range-all',
      chat_jid: 'group@g.us',
      include_tool_calls: true,
    } as unknown as Parameters<typeof processTaskIpc>[0];

    await processTaskIpc(dataWithJid, 'main_group', true, deps);

    expect(mockGetMessageRange).toHaveBeenCalledWith('group@g.us', 0, 20, true);
  });

  it('缺 chat_jid → error response', async () => {
    await processTaskIpc(
      { type: 'get_message_range', requestId: 'req-range-err' } as Parameters<typeof processTaskIpc>[0],
      'main_group', true, deps,
    );

    const filePath = path.join(tmpDir, 'ipc', 'main_group', 'responses', 'req-range-err.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(data.error).toContain('chat_jid');
  });
});
