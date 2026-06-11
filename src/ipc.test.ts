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
const mockCreateTaskLedgerTask = vi.fn();
const mockGetTaskLedgerTask = vi.fn();
const mockListTaskLedgerTasks = vi.fn();
const mockUpdateTaskLedgerTask = vi.fn();
const mockAddTaskLedgerEvent = vi.fn();
const mockUpsertTaskLedgerChecklistItem = vi.fn();
const mockUpsertTaskLedgerTestCase = vi.fn();
const mockGetMessageContext = vi.fn();
const mockGetMessageContextById = vi.fn();
const mockGetMessageRange = vi.fn();
const mockClampRangeParams = vi.fn();

vi.mock('./db.js', () => ({
  createTask: (...args: unknown[]) => mockCreateTask(...args),
  deleteTask: (...args: unknown[]) => mockDeleteTask(...args),
  getTaskById: (...args: unknown[]) => mockGetTaskById(...args),
  updateTask: (...args: unknown[]) => mockUpdateTask(...args),
  createTaskLedgerTask: (...args: unknown[]) =>
    mockCreateTaskLedgerTask(...args),
  getTaskLedgerTask: (...args: unknown[]) => mockGetTaskLedgerTask(...args),
  listTaskLedgerTasks: (...args: unknown[]) => mockListTaskLedgerTasks(...args),
  updateTaskLedgerTask: (...args: unknown[]) =>
    mockUpdateTaskLedgerTask(...args),
  addTaskLedgerEvent: (...args: unknown[]) => mockAddTaskLedgerEvent(...args),
  upsertTaskLedgerChecklistItem: (...args: unknown[]) =>
    mockUpsertTaskLedgerChecklistItem(...args),
  upsertTaskLedgerTestCase: (...args: unknown[]) =>
    mockUpsertTaskLedgerTestCase(...args),
  storeMessageDirect: vi.fn(),
  getMessageContext: (...args: unknown[]) => mockGetMessageContext(...args),
  getMessageContextById: (...args: unknown[]) =>
    mockGetMessageContextById(...args),
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

import {
  writeIpcResponse,
  processTaskIpc,
  isDuplicateMessage,
  recentMessages,
  canSendMessageViaIpc,
  IpcDeps,
} from './ipc.js';
import type { RegisteredGroup } from './types.js';

// ---- helpers ----

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'main_group',
  trigger: 'always',
  added_at: '2024-01-01',
  isMain: true,
};
const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'other_group',
  trigger: '@bot',
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
    registerGroup: vi.fn((jid, g) => {
      groups[jid] = g;
    }),
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
    const filePath = path.join(
      tmpDir,
      'ipc',
      subDir,
      'responses',
      'req-2.json',
    );
    expect(fs.existsSync(filePath)).toBe(true);
  });
});

// ---- processTaskIpc: update_task ----

describe('processTaskIpc - update_task', () => {
  it('更新 prompt → 调用 updateTask', async () => {
    mockGetTaskById.mockReturnValue({
      id: 'task-1',
      group_folder: 'main_group',
      prompt: '旧',
      schedule_type: 'once',
      schedule_value: '2025-01-01',
    });

    await processTaskIpc(
      { type: 'update_task', taskId: 'task-1', prompt: '新 prompt' },
      'main_group',
      true,
      deps,
    );

    expect(mockUpdateTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ prompt: '新 prompt' }),
    );
    expect(deps.onTasksChanged).toHaveBeenCalled();
  });

  it('任务不存在 → 不调用 updateTask', async () => {
    mockGetTaskById.mockReturnValue(undefined);
    await processTaskIpc(
      { type: 'update_task', taskId: 'nope', prompt: 'x' },
      'main_group',
      true,
      deps,
    );
    expect(mockUpdateTask).not.toHaveBeenCalled();
  });

  it('非 main group 更新别组任务 → 被阻止', async () => {
    mockGetTaskById.mockReturnValue({
      id: 'task-1',
      group_folder: 'main_group',
      prompt: '旧',
      schedule_type: 'once',
      schedule_value: '2025-01-01',
    });

    await processTaskIpc(
      { type: 'update_task', taskId: 'task-1', prompt: '篡改' },
      'other_group',
      false,
      deps,
    );

    expect(mockUpdateTask).not.toHaveBeenCalled();
  });
});

// ---- processTaskIpc: memory_recall ----

describe('processTaskIpc - memory_recall', () => {
  it('有 query → 走 MemoryStore.recall + 写 response', async () => {
    mockRecall.mockResolvedValue([
      {
        id: 'm1',
        content: '记忆内容',
        score: 0.9,
        metadata: { category: 'context' },
        createdAt: '2024-01-01',
      },
    ]);

    await processTaskIpc(
      { type: 'memory_recall', requestId: 'req-recall', query: '搜索' },
      'main_group',
      true,
      deps,
    );

    // 验证 response 文件
    const filePath = path.join(
      tmpDir,
      'ipc',
      'main_group',
      'responses',
      'req-recall.json',
    );
    expect(fs.existsSync(filePath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(data.facts).toHaveLength(1);
    expect(data.facts[0].content).toBe('记忆内容');
  });

  it('memory 未启用 → 返回 error', async () => {
    mockIsMemoryEnabled.mockReturnValue(false);

    await processTaskIpc(
      { type: 'memory_recall', requestId: 'req-disabled', query: '搜索' },
      'main_group',
      true,
      deps,
    );

    const filePath = path.join(
      tmpDir,
      'ipc',
      'main_group',
      'responses',
      'req-disabled.json',
    );
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(data.error).toContain('disabled');
  });

  it('缺少 requestId → 不写 response', async () => {
    await processTaskIpc(
      { type: 'memory_recall', query: '搜索' },
      'main_group',
      true,
      deps,
    );
    // 不应该崩溃，也不写文件
  });
});

// ---- processTaskIpc: memory_remember ----

describe('processTaskIpc - memory_remember', () => {
  it('有 content → 存储 + 异步精炼', async () => {
    await processTaskIpc(
      { type: 'memory_remember', content: '重要记忆', senderId: 'user-1' },
      'main_group',
      true,
      deps,
    );

    expect(mockStoreFactRaw).toHaveBeenCalled();
    expect(mockExtractAndRefine).toHaveBeenCalled();
  });

  it('缺少 content → 不存储', async () => {
    await processTaskIpc({ type: 'memory_remember' }, 'main_group', true, deps);

    expect(mockStoreFactRaw).not.toHaveBeenCalled();
  });

  it('memory 未启用 → 跳过', async () => {
    mockIsMemoryEnabled.mockReturnValue(false);

    await processTaskIpc(
      { type: 'memory_remember', content: '应该被忽略' },
      'main_group',
      true,
      deps,
    );

    expect(mockStoreFactRaw).not.toHaveBeenCalled();
  });
});

// ---- processTaskIpc: get_feishu_token ----

describe('processTaskIpc - get_feishu_token', () => {
  it('成功获取 token → 写 response', async () => {
    await processTaskIpc(
      {
        type: 'get_feishu_token',
        requestId: 'req-token',
        chatJid: 'fs:oc_main',
        senderId: 'user-1',
      },
      'main_group',
      true,
      deps,
    );

    const filePath = path.join(
      tmpDir,
      'ipc',
      'main_group',
      'responses',
      'req-token.json',
    );
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(data.token).toBe('mock-token');
    expect(data.error).toBeNull();
  });

  it('缺少 requestId → 不写 response', async () => {
    await processTaskIpc(
      { type: 'get_feishu_token', chatJid: 'fs:oc_main' },
      'main_group',
      true,
      deps,
    );
    // 不应该崩溃
  });
});

// ---- processTaskIpc: rename_chat (message type, tested via processTaskIpc) ----
// 注意：rename_chat 在 startIpcWatcher 中处理，不是 processTaskIpc。
// 但 refresh_groups 是 processTaskIpc 的一部分。

describe('processTaskIpc - refresh_groups', () => {
  it('main group → 触发 syncGroups', async () => {
    await processTaskIpc({ type: 'refresh_groups' }, 'main_group', true, deps);

    expect(deps.syncGroups).toHaveBeenCalledWith(true);
    expect(deps.writeGroupsSnapshot).toHaveBeenCalled();
  });

  it('非 main group → 被阻止', async () => {
    await processTaskIpc(
      { type: 'refresh_groups' },
      'other_group',
      false,
      deps,
    );

    expect(deps.syncGroups).not.toHaveBeenCalled();
  });
});

// ---- processTaskIpc: task ledger ----

describe('processTaskIpc - task ledger', () => {
  function readResponse(requestId: string, group = 'main_group') {
    const filePath = path.join(
      tmpDir,
      'ipc',
      group,
      'responses',
      `${requestId}.json`,
    );
    expect(fs.existsSync(filePath)).toBe(true);
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }

  it('task_create → 创建结构化任务并写 response', async () => {
    mockCreateTaskLedgerTask.mockReturnValue({
      task: {
        id: 'tl-1',
        title: '任务账本 MCP',
        owner_group: 'main_group',
        acceptance_criteria: ['能创建任务'],
      },
      checklist: [],
      test_cases: [],
      events: [],
    });

    await processTaskIpc(
      {
        type: 'task_create',
        requestId: 'req-create',
        title: '任务账本 MCP',
        project: 'nanoclaw',
        task_type: 'feature',
        desired_outcome: 'LLM 能追踪任务进展',
        acceptance_criteria: ['能创建任务'],
        checklist: [{ title: '设计 schema' }],
        test_cases: [{ title: '创建后能查询' }],
        senderId: 'user-1',
      } as never,
      'main_group',
      true,
      deps,
    );

    expect(mockCreateTaskLedgerTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '任务账本 MCP',
        project: 'nanoclaw',
        task_type: 'feature',
        owner_group: 'main_group',
        created_by: 'user-1',
      }),
    );
    const response = readResponse('req-create');
    expect(response.task.id).toBe('tl-1');
  });

  it('task_list 非 main group 只能列本群任务', async () => {
    mockListTaskLedgerTasks.mockReturnValue([]);

    await processTaskIpc(
      {
        type: 'task_list',
        requestId: 'req-list',
        owner_group: 'main_group',
      } as never,
      'other_group',
      false,
      deps,
    );

    expect(mockListTaskLedgerTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        owner_group: 'other_group',
      }),
    );
    const response = readResponse('req-list', 'other_group');
    expect(response.tasks).toEqual([]);
  });

  it('task_get 非 owner 群访问 → 返回 not found', async () => {
    mockGetTaskLedgerTask.mockReturnValue({
      task: { id: 'tl-1', owner_group: 'main_group' },
      checklist: [],
      test_cases: [],
      events: [],
    });

    await processTaskIpc(
      { type: 'task_get', requestId: 'req-get', taskId: 'tl-1' },
      'other_group',
      false,
      deps,
    );

    const response = readResponse('req-get', 'other_group');
    expect(response.error).toBe('Task not found');
  });

  it('task_add_log owner 群可追加过程记录', async () => {
    mockGetTaskLedgerTask.mockReturnValue({
      task: { id: 'tl-1', owner_group: 'main_group' },
      checklist: [],
      test_cases: [],
      events: [],
    });
    mockAddTaskLedgerEvent.mockReturnValue({
      id: 1,
      task_id: 'tl-1',
      event_type: 'evidence',
      summary: '测试通过',
    });

    await processTaskIpc(
      {
        type: 'task_add_log',
        requestId: 'req-log',
        taskId: 'tl-1',
        event_type: 'evidence',
        summary: '测试通过',
        details: 'npm test passed',
        senderId: 'user-1',
      },
      'main_group',
      false,
      deps,
    );

    expect(mockAddTaskLedgerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        task_id: 'tl-1',
        actor_group: 'main_group',
        actor_sender: 'user-1',
      }),
    );
    const response = readResponse('req-log');
    expect(response.event.summary).toBe('测试通过');
  });

  it('task_update_checklist 和 task_update_test_case 可写执行与验收状态', async () => {
    mockGetTaskLedgerTask.mockReturnValue({
      task: { id: 'tl-1', owner_group: 'main_group' },
      checklist: [],
      test_cases: [],
      events: [],
    });
    mockUpsertTaskLedgerChecklistItem.mockReturnValue({
      id: 'cli-1',
      status: 'done',
    });
    mockUpsertTaskLedgerTestCase.mockReturnValue({
      id: 'tc-1',
      status: 'passed',
    });

    await processTaskIpc(
      {
        type: 'task_update_checklist',
        requestId: 'req-check',
        taskId: 'tl-1',
        title: '跑 build',
        status: 'done',
      } as never,
      'main_group',
      false,
      deps,
    );
    await processTaskIpc(
      {
        type: 'task_update_test_case',
        requestId: 'req-case',
        taskId: 'tl-1',
        title: 'E2E 验证',
        status: 'passed',
        evidence: 'trace ok',
      } as never,
      'main_group',
      false,
      deps,
    );

    expect(readResponse('req-check').item.status).toBe('done');
    expect(readResponse('req-case').test_case.status).toBe('passed');
  });

  it('task_update 不能绕过 workflow 直接改状态', async () => {
    mockGetTaskLedgerTask.mockReturnValue({
      task: { id: 'tl-1', owner_group: 'main_group', status: 'draft' },
      checklist: [],
      test_cases: [],
      events: [],
    });

    await processTaskIpc(
      {
        type: 'task_update',
        requestId: 'req-update-status',
        taskId: 'tl-1',
        status: 'done',
      } as never,
      'main_group',
      false,
      deps,
    );

    expect(mockUpdateTaskLedgerTask).not.toHaveBeenCalled();
    expect(readResponse('req-update-status').error).toContain('workflow tools');
  });

  it('未锁定最终效果时不能定义 E2E', async () => {
    mockGetTaskLedgerTask.mockReturnValue({
      task: { id: 'tl-1', owner_group: 'main_group', status: 'draft' },
      checklist: [],
      test_cases: [],
      events: [],
    });

    await processTaskIpc(
      {
        type: 'task_define_e2e',
        requestId: 'req-e2e-before-effect',
        taskId: 'tl-1',
        test_cases: [{ title: '端到端验收' }],
      } as never,
      'main_group',
      false,
      deps,
    );

    expect(readResponse('req-e2e-before-effect').error).toContain('Lock desired outcome');
  });

  it('完整 workflow 能从锁效果推进到验证阶段', async () => {
    mockUpdateTaskLedgerTask.mockReturnValue({ task: { id: 'tl-1' } });

    mockGetTaskLedgerTask.mockReturnValue({
      task: { id: 'tl-1', owner_group: 'main_group', status: 'draft' },
      checklist: [],
      test_cases: [],
      events: [],
    });
    await processTaskIpc(
      {
        type: 'task_lock_effect',
        requestId: 'req-lock',
        taskId: 'tl-1',
        desired_outcome: 'LLM 必须先锁目标再实现',
        acceptance_criteria: ['没锁目标不能实现'],
        senderId: 'user-1',
      } as never,
      'main_group',
      false,
      deps,
    );

    mockGetTaskLedgerTask.mockReturnValue({
      task: { id: 'tl-1', owner_group: 'main_group', status: 'effect_locked' },
      checklist: [],
      test_cases: [],
      events: [],
    });
    await processTaskIpc(
      {
        type: 'task_define_e2e',
        requestId: 'req-e2e',
        taskId: 'tl-1',
        test_cases: [{ title: '未锁目标时实现被拒绝' }],
      } as never,
      'main_group',
      false,
      deps,
    );

    mockGetTaskLedgerTask.mockReturnValue({
      task: { id: 'tl-1', owner_group: 'main_group', status: 'e2e_defined' },
      checklist: [],
      test_cases: [{ id: 'tc-1', status: 'pending' }],
      events: [],
    });
    await processTaskIpc(
      {
        type: 'task_plan_tests',
        requestId: 'req-plan',
        taskId: 'tl-1',
        checklist: [{ title: '补门禁测试' }],
      } as never,
      'main_group',
      false,
      deps,
    );

    mockGetTaskLedgerTask.mockReturnValue({
      task: { id: 'tl-1', owner_group: 'main_group', status: 'tests_planned' },
      checklist: [{ id: 'cli-1', status: 'todo' }],
      test_cases: [{ id: 'tc-1', status: 'pending' }],
      events: [],
    });
    await processTaskIpc(
      {
        type: 'task_start_implementation',
        requestId: 'req-start',
        taskId: 'tl-1',
      },
      'main_group',
      false,
      deps,
    );

    mockGetTaskLedgerTask.mockReturnValue({
      task: { id: 'tl-1', owner_group: 'main_group', status: 'implementing' },
      checklist: [{ id: 'cli-1', status: 'done' }],
      test_cases: [{ id: 'tc-1', status: 'pending' }],
      events: [],
    });
    await processTaskIpc(
      {
        type: 'task_record_verification',
        requestId: 'req-verify',
        taskId: 'tl-1',
        title: '目标测试',
        status: 'passed',
        evidence: '104 passed',
      } as never,
      'main_group',
      false,
      deps,
    );

    expect(mockUpdateTaskLedgerTask).toHaveBeenCalledWith('tl-1', expect.objectContaining({ status: 'effect_locked' }));
    expect(mockUpdateTaskLedgerTask).toHaveBeenCalledWith('tl-1', { status: 'e2e_defined' });
    expect(mockUpdateTaskLedgerTask).toHaveBeenCalledWith('tl-1', { status: 'tests_planned' });
    expect(mockUpdateTaskLedgerTask).toHaveBeenCalledWith('tl-1', { status: 'implementing' });
    expect(mockUpdateTaskLedgerTask).toHaveBeenCalledWith('tl-1', { status: 'verifying' });
    expect(readResponse('req-lock').task.id).toBe('tl-1');
    expect(readResponse('req-verify').task.id).toBe('tl-1');
  });

  it('有未完成清单或未通过用例时不能标记完成', async () => {
    mockGetTaskLedgerTask.mockReturnValue({
      task: { id: 'tl-1', owner_group: 'main_group', status: 'verifying' },
      checklist: [{ id: 'cli-1', title: '跑 E2E', status: 'todo' }],
      test_cases: [{ id: 'tc-1', title: 'E2E', status: 'pending' }],
      events: [],
    });

    await processTaskIpc(
      {
        type: 'task_mark_done',
        requestId: 'req-done-blocked',
        taskId: 'tl-1',
      },
      'main_group',
      false,
      deps,
    );

    const response = readResponse('req-done-blocked');
    expect(response.error).toContain('Cannot mark done');
    expect(response.open_checklist).toHaveLength(1);
    expect(response.open_test_cases).toHaveLength(1);
  });
});

// ---- unknown type ----

describe('processTaskIpc - unknown type', () => {
  it('未知类型 → 不崩溃，记 warn', async () => {
    await processTaskIpc(
      { type: 'nonexistent_type' },
      'main_group',
      true,
      deps,
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
    const key =
      'jid1:' + require('crypto').createHash('md5').update('old').digest('hex');
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

// ---- send_message authorization ----

describe('canSendMessageViaIpc', () => {
  it('允许同群 send_message', () => {
    expect(canSendMessageViaIpc('main_group', 'fs:oc_main', groups)).toBe(true);
  });

  it('即使源群是主群，也不允许跨群 send_message', () => {
    expect(canSendMessageViaIpc('main_group', 'fs:oc_other', groups)).toBe(
      false,
    );
  });

  it('目标群未注册时拒绝 send_message', () => {
    expect(canSendMessageViaIpc('main_group', 'fs:oc_missing', groups)).toBe(
      false,
    );
  });
});

// ---- processTaskIpc: get_chat_context ----

describe('processTaskIpc - get_chat_context', () => {
  it('默认过滤工具调用记录', async () => {
    mockGetMessageContext.mockReturnValue({
      before: [],
      anchor: {
        sender_name: 'Bob',
        content: '锚点',
        timestamp: '2024-01-01T00:01:00Z',
        is_from_me: true,
      },
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
      'main_group',
      true,
      deps,
    );

    expect(mockGetMessageContext).toHaveBeenCalledWith(
      'group@g.us',
      '2024-01-01T00:01:00Z',
      2,
      4,
      false,
    );
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
      'main_group',
      true,
      deps,
    );

    expect(mockGetMessageContext).toHaveBeenCalledWith(
      'group@g.us',
      '2024-01-01T00:01:00Z',
      5,
      5,
      true,
    );
  });
});

// ---- processTaskIpc: get_message_by_id ----

describe('processTaskIpc - get_message_by_id', () => {
  it('有 message_id → 调 getMessageContextById 并写 response', async () => {
    mockGetMessageContextById.mockReturnValue({
      before: [
        {
          sender_name: 'Alice',
          content: '前',
          timestamp: '2024-01-01T00:00:00Z',
          is_from_me: false,
        },
      ],
      anchor: {
        sender_name: 'Bob',
        content: '锚点',
        timestamp: '2024-01-01T00:01:00Z',
        is_from_me: true,
      },
      after: [],
    });

    await processTaskIpc(
      { type: 'get_message_by_id', requestId: 'req-byid-1' } as Parameters<
        typeof processTaskIpc
      >[0],
      'main_group',
      true,
      deps,
    );

    // 先补 message_id 字段（processTaskIpc 用 data as Record<string, unknown> 读）
    const dataWithId = {
      type: 'get_message_by_id',
      requestId: 'req-byid-2',
      message_id: 'msg-abc',
      before: 3,
      after: 3,
    } as unknown as Parameters<typeof processTaskIpc>[0];
    await processTaskIpc(dataWithId, 'main_group', true, deps);

    const filePath = path.join(
      tmpDir,
      'ipc',
      'main_group',
      'responses',
      'req-byid-2.json',
    );
    expect(fs.existsSync(filePath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(data.anchor.content).toBe('锚点');
    expect(mockGetMessageContextById).toHaveBeenCalledWith(
      'msg-abc',
      3,
      3,
      false,
    );
  });

  it('include_tool_calls=true → 按 ID 查询全量上下文', async () => {
    const dataWithId = {
      type: 'get_message_by_id',
      requestId: 'req-byid-all',
      message_id: 'msg-abc',
      include_tool_calls: true,
    } as unknown as Parameters<typeof processTaskIpc>[0];

    await processTaskIpc(dataWithId, 'main_group', true, deps);

    expect(mockGetMessageContextById).toHaveBeenCalledWith(
      'msg-abc',
      5,
      5,
      true,
    );
  });

  it('缺 message_id → error response', async () => {
    await processTaskIpc(
      { type: 'get_message_by_id', requestId: 'req-byid-err' } as Parameters<
        typeof processTaskIpc
      >[0],
      'main_group',
      true,
      deps,
    );

    const filePath = path.join(
      tmpDir,
      'ipc',
      'main_group',
      'responses',
      'req-byid-err.json',
    );
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(data.error).toContain('message_id');
  });

  it('缺 requestId → 不写 response', async () => {
    await processTaskIpc(
      { type: 'get_message_by_id' } as Parameters<typeof processTaskIpc>[0],
      'main_group',
      true,
      deps,
    );
    // 不崩溃即可
  });
});

// ---- processTaskIpc: get_message_range ----

describe('processTaskIpc - get_message_range', () => {
  it('有 chat_jid → clamp + 调 getMessageRange + 写 response', async () => {
    mockGetMessageRange.mockReturnValue([
      {
        sender_name: 'Alice',
        content: '消息1',
        timestamp: '2024-01-01T00:00:00Z',
        is_from_me: false,
      },
    ]);

    const dataWithJid = {
      type: 'get_message_range',
      requestId: 'req-range-1',
      chat_jid: 'group@g.us',
      offset: 0,
      limit: 10,
    } as unknown as Parameters<typeof processTaskIpc>[0];
    await processTaskIpc(dataWithJid, 'main_group', true, deps);

    const filePath = path.join(
      tmpDir,
      'ipc',
      'main_group',
      'responses',
      'req-range-1.json',
    );
    expect(fs.existsSync(filePath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].content).toBe('消息1');
    expect(mockClampRangeParams).toHaveBeenCalledWith(0, 10);
    expect(mockGetMessageRange).toHaveBeenCalledWith(
      'group@g.us',
      0,
      10,
      false,
    );
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
      { type: 'get_message_range', requestId: 'req-range-err' } as Parameters<
        typeof processTaskIpc
      >[0],
      'main_group',
      true,
      deps,
    );

    const filePath = path.join(
      tmpDir,
      'ipc',
      'main_group',
      'responses',
      'req-range-err.json',
    );
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(data.error).toContain('chat_jid');
  });
});
