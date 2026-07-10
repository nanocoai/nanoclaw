import fs from 'fs';

import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  clampRangeParams,
  addTaskLedgerEvent,
  createTask,
  createTaskLedgerTask,
  deleteTask,
  getAllChats,
  getAliasByJid,
  getAllGroupAliases,
  getAllRegisteredGroups,
  getGroupAlias,
  getLastBotMessageTimestamp,
  getMessageContext,
  getMessageContextById,
  getMessageRange,
  getMessagesSince,
  getNewMessages,
  getTaskById,
  getTaskLedgerTask,
  listTaskLedgerTasks,
  setGroupAlias,
  setRegisteredGroup,
  storeChatMetadata,
  storeMessage,
  storeMessageDirect,
  updateTaskLedgerTask,
  upsertTaskLedgerChecklistItem,
  upsertTaskLedgerTestCase,
  updateTask,
} from './db.js';
import { formatMessages } from './router.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('task ledger db', () => {
  it('创建任务时保存最终效果、验收标准、清单和测试用例', () => {
    const detail = createTaskLedgerTask({
      title: '实现任务账本 MCP',
      project: 'nanoclaw',
      task_type: 'feature',
      status: 'ready',
      owner_group: 'main_group',
      created_by: 'user-1',
      desired_outcome: 'LLM 能查看任务进度并记录验收证据',
      acceptance_criteria: ['能创建任务', '能记录 E2E 证据'],
      checklist: [{ title: '设计 schema' }, { title: '接 MCP 工具' }],
      test_cases: [{ title: '创建任务后能查询详情' }],
    });

    expect(detail.task.id).toMatch(/^tl_/);
    expect(detail.task.acceptance_criteria).toEqual([
      '能创建任务',
      '能记录 E2E 证据',
    ]);
    expect(detail.checklist.map((item) => item.title)).toEqual([
      '设计 schema',
      '接 MCP 工具',
    ]);
    expect(detail.test_cases[0].status).toBe('pending');
    expect(detail.events[0].event_type).toBe('created');
    expect(detail.task.artifact_root).toContain('task-ledger');
    expect(detail.task.prd_path).toBe(`${detail.task.artifact_root}/prd.md`);
    expect(fs.existsSync(`${detail.task.artifact_root}/task.yaml`)).toBe(true);
    expect(fs.existsSync(`${detail.task.artifact_root}/prd.md`)).toBe(true);
    expect(fs.existsSync(`${detail.task.artifact_root}/e2e-cases.md`)).toBe(
      true,
    );
  });

  it('支持按项目和未完成状态列任务', () => {
    createTaskLedgerTask({
      title: '未完成任务',
      project: 'nine',
      task_type: 'bug',
      owner_group: 'main_group',
    });
    createTaskLedgerTask({
      title: '已完成任务',
      project: 'nine',
      task_type: 'bug',
      status: 'done',
      owner_group: 'main_group',
    });

    const active = listTaskLedgerTasks({ project: 'nine' });
    expect(active).toHaveLength(1);
    expect(active[0].title).toBe('未完成任务');

    const all = listTaskLedgerTasks({ project: 'nine', include_done: true });
    expect(all).toHaveLength(2);
  });

  it('更新任务、清单、测试用例和过程日志', () => {
    const created = createTaskLedgerTask({
      title: '修 bug',
      project: 'nine',
      task_type: 'bug',
      owner_group: 'main_group',
    });
    const taskId = created.task.id;

    const updated = updateTaskLedgerTask(taskId, {
      status: 'in_progress',
      desired_outcome: '异常有清晰错误，不静默失败',
      acceptance_criteria: ['RED 用例先失败', '修复后通过'],
    });
    expect(updated?.task.status).toBe('in_progress');
    expect(updated?.task.acceptance_criteria).toHaveLength(2);

    const checklist = upsertTaskLedgerChecklistItem({
      task_id: taskId,
      title: '补 RED 测试',
      status: 'done',
      notes: '已覆盖',
    });
    expect(checklist?.status).toBe('done');

    const testCase = upsertTaskLedgerTestCase({
      task_id: taskId,
      title: '异常路径 E2E',
      status: 'passed',
      evidence: 'npm test -- task-ledger',
    });
    expect(testCase?.evidence).toContain('npm test');

    const event = addTaskLedgerEvent({
      task_id: taskId,
      event_type: 'evidence',
      summary: '目标测试通过',
      details: '1 passed',
      actor_group: 'main_group',
    });
    expect(event?.summary).toBe('目标测试通过');

    const detail = getTaskLedgerTask(taskId);
    expect(detail?.checklist[0].title).toBe('补 RED 测试');
    expect(detail?.test_cases[0].status).toBe('passed');
    expect(detail?.events.some((item) => item.event_type === 'evidence')).toBe(
      true,
    );
    expect(
      fs.readFileSync(`${detail?.task.artifact_root}/task.yaml`, 'utf8'),
    ).toContain('异常路径 E2E');
  });
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('filters out empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(0);
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- reply context persistence ---

describe('reply context', () => {
  it('stores and retrieves reply_to fields', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'reply-1',
      chat_jid: 'group@g.us',
      sender: '123',
      sender_name: 'Alice',
      content: 'Yes, on my way!',
      timestamp: '2024-01-01T00:00:01.000Z',
      reply_to_message_id: '42',
      reply_to_message_content: 'Are you coming tonight?',
      reply_to_sender_name: 'Bob',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].reply_to_message_id).toBe('42');
    expect(messages[0].reply_to_message_content).toBe(
      'Are you coming tonight?',
    );
    expect(messages[0].reply_to_sender_name).toBe('Bob');
  });

  it('returns null for messages without reply context', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'no-reply',
      chat_jid: 'group@g.us',
      sender: '123',
      sender_name: 'Alice',
      content: 'Just a normal message',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].reply_to_message_id).toBeNull();
    expect(messages[0].reply_to_message_content).toBeNull();
    expect(messages[0].reply_to_sender_name).toBeNull();
  });

  it('retrieves reply context via getNewMessages', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'reply-2',
      chat_jid: 'group@g.us',
      sender: '456',
      sender_name: 'Carol',
      content: 'Agreed',
      timestamp: '2024-01-01T00:00:01.000Z',
      reply_to_message_id: '99',
      reply_to_message_content: 'We should meet',
      reply_to_sender_name: 'Dave',
    });

    const { messages } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].reply_to_message_id).toBe('99');
    expect(messages[0].reply_to_sender_name).toBe('Dave');
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'm2',
      chat_jid: 'group@g.us',
      sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'm3',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'm4',
      chat_jid: 'group@g.us',
      sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Should exclude m1, m2 (before/at timestamp), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes bot messages via is_bot_message flag', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all non-bot messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '', 'Andy');
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });

  it('recovers cursor from last bot reply when lastAgentTimestamp is missing', () => {
    // beforeEach already inserts m3 (bot reply at 00:00:03) and m4 (user at 00:00:04)
    // Add more old history before the bot reply
    for (let i = 1; i <= 50; i++) {
      store({
        id: `history-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `old message ${i}`,
        timestamp: `2023-06-${String(i).padStart(2, '0')}T12:00:00.000Z`,
      });
    }

    // New message after the bot reply (m3 at 00:00:03)
    store({
      id: 'new-1',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'new message after bot reply',
      timestamp: '2024-01-02T00:00:00.000Z',
    });

    // Recover cursor from the last bot message (m3 from beforeEach)
    const recovered = getLastBotMessageTimestamp('group@g.us', 'Andy');
    expect(recovered).toBe('2024-01-01T00:00:03.000Z');

    // Using recovered cursor: only gets messages after the bot reply
    const msgs = getMessagesSince('group@g.us', recovered!, 'Andy', 10);
    // m4 (third, 00:00:04) + new-1 — skips all 50 old messages and m1/m2
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe('third');
    expect(msgs[1].content).toBe('new message after bot reply');
  });

  it('caps messages to configured limit even with recovered cursor', () => {
    // beforeEach inserts m3 (bot at 00:00:03). Add 30 messages after it.
    for (let i = 1; i <= 30; i++) {
      store({
        id: `pending-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `pending message ${i}`,
        timestamp: `2024-02-${String(i).padStart(2, '0')}T12:00:00.000Z`,
      });
    }

    const recovered = getLastBotMessageTimestamp('group@g.us', 'Andy');
    expect(recovered).toBe('2024-01-01T00:00:03.000Z');

    // With limit=10, only the 10 most recent are returned
    const msgs = getMessagesSince('group@g.us', recovered!, 'Andy', 10);
    expect(msgs).toHaveLength(10);
    // Most recent 10: pending-21 through pending-30
    expect(msgs[0].content).toBe('pending message 21');
    expect(msgs[9].content).toBe('pending message 30');
  });

  it('returns last N messages when no bot reply and no cursor exist', () => {
    // Use a fresh group with no bot messages
    storeChatMetadata('fresh@g.us', '2024-01-01T00:00:00.000Z');
    for (let i = 1; i <= 20; i++) {
      store({
        id: `fresh-${i}`,
        chat_jid: 'fresh@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-02-${String(i).padStart(2, '0')}T12:00:00.000Z`,
      });
    }

    const recovered = getLastBotMessageTimestamp('fresh@g.us', 'Andy');
    expect(recovered).toBeUndefined();

    // No cursor → sinceTimestamp = '' but limit caps the result
    const msgs = getMessagesSince('fresh@g.us', '', 'Andy', 10);
    expect(msgs).toHaveLength(10);

    const prompt = formatMessages(msgs, 'Asia/Jerusalem');
    const messageTagCount = (prompt.match(/<message /g) || []).length;
    expect(messageTagCount).toBe(10);
  });

  it('filters pre-migration bot messages via content prefix backstop', () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    store({
      id: 'm5',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'Andy: old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:04.000Z',
      'Andy',
    );
    expect(msgs).toHaveLength(0);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'a1',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'a2',
      chat_jid: 'group2@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'a3',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'a4',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    // Excludes bot message, returns 3 user messages
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', () => {
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Only g1 msg2 (after ts, not bot)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '', 'Andy');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });
});

// --- LIMIT behavior ---

describe('message query LIMIT', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    for (let i = 1; i <= 10; i++) {
      store({
        id: `lim-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
  });

  it('getNewMessages caps to limit and returns most recent in chronological order', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    // Chronological order preserved
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
    // newTimestamp reflects latest returned row
    expect(newTimestamp).toBe('2024-01-01T00:00:10.000Z');
  });

  it('getMessagesSince caps to limit and returns most recent in chronological order', () => {
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
  });

  it('returns all messages when count is under the limit', () => {
    const { messages } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      50,
    );
    expect(messages).toHaveLength(10);
  });
});

// --- RegisteredGroup isMain round-trip ---

describe('registered group isMain', () => {
  it('persists isMain=true through set/get round-trip', () => {
    setRegisteredGroup('main@s.whatsapp.net', {
      name: 'Main Chat',
      folder: 'whatsapp_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const groups = getAllRegisteredGroups();
    const group = groups['main@s.whatsapp.net'];
    expect(group).toBeDefined();
    expect(group.isMain).toBe(true);
    expect(group.folder).toBe('whatsapp_main');
  });

  it('omits isMain for non-main groups', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Family Chat',
      folder: 'whatsapp_family-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    const group = groups['group@g.us'];
    expect(group).toBeDefined();
    expect(group.isMain).toBeUndefined();
  });
});

// --- group aliases ---

describe('group aliases', () => {
  it('保存并读取群别名', () => {
    setGroupAlias('2号', 'fs:oc_two');

    expect(getGroupAlias('2号')).toBe('fs:oc_two');
    expect(getAllGroupAliases()).toEqual({ '2号': 'fs:oc_two' });
  });

  it('重复设置同一别名会覆盖目标群', () => {
    setGroupAlias('2号', 'fs:oc_old');
    setGroupAlias('2号', 'fs:oc_new');

    expect(getGroupAlias('2号')).toBe('fs:oc_new');
  });

  it('空别名会被拒绝', () => {
    expect(() => setGroupAlias('   ', 'fs:oc_two')).toThrow('别名不能为空');
  });

  it('getAliasByJid 按 JID 反查别名', () => {
    setGroupAlias('C2', 'fs:oc_two');
    setGroupAlias('C3', 'fs:oc_three');

    expect(getAliasByJid('fs:oc_two')).toBe('C2');
    expect(getAliasByJid('fs:oc_three')).toBe('C3');
    expect(getAliasByJid('fs:oc_nonexistent')).toBeUndefined();
  });
});

// --- getMessageContext ---

// 批量写入消息的辅助函数
function seedMessages(
  chatJid: string,
  count: number,
  baseTime = '2024-06-01T10:00:00.000Z',
) {
  storeChatMetadata(chatJid, baseTime);
  const base = new Date(baseTime).getTime();
  for (let i = 0; i < count; i++) {
    const ts = new Date(base + i * 60_000).toISOString(); // 每条间隔 1 分钟
    storeMessage({
      id: `ctx-${chatJid}-${i}`,
      chat_jid: chatJid,
      sender: i % 2 === 0 ? 'alice@s' : 'bob@s',
      sender_name: i % 2 === 0 ? 'Alice' : 'Bob',
      content: `消息 #${i}`,
      timestamp: ts,
      is_from_me: i % 2 === 1,
    });
  }
  return base;
}

describe('getMessageContext', () => {
  const JID = 'test-ctx@g.us';

  it('精确命中锚点，返回前后各 N 条', () => {
    const base = seedMessages(JID, 11); // msg-0 ~ msg-10
    const anchorTs = new Date(base + 5 * 60_000).toISOString();

    const result = getMessageContext(JID, anchorTs, 3, 3);

    expect(result.anchor).not.toBeNull();
    expect(result.anchor!.content).toBe('消息 #5');
    expect(result.before).toHaveLength(3);
    expect(result.before.map((m) => m.content)).toEqual([
      '消息 #2',
      '消息 #3',
      '消息 #4',
    ]);
    expect(result.after).toHaveLength(3);
    expect(result.after.map((m) => m.content)).toEqual([
      '消息 #6',
      '消息 #7',
      '消息 #8',
    ]);
  });

  it('锚点在两条消息之间时，命中最近的一条', () => {
    const base = seedMessages(JID, 5);
    // +2min30s+1ms：距 msg-2(+2min)=30s1ms，距 msg-3(+3min)=29s999ms → 命中 msg-3
    const betweenTs = new Date(base + 2.5 * 60_000 + 1).toISOString();

    const result = getMessageContext(JID, betweenTs, 2, 2);

    expect(result.anchor).not.toBeNull();
    expect(result.anchor!.content).toBe('消息 #3');
  });

  it('锚点是第一条消息时 before 为空', () => {
    const base = seedMessages(JID, 5);
    const firstTs = new Date(base).toISOString();

    const result = getMessageContext(JID, firstTs, 5, 2);

    expect(result.anchor!.content).toBe('消息 #0');
    expect(result.before).toHaveLength(0);
    expect(result.after).toHaveLength(2);
  });

  it('锚点是最后一条消息时 after 为空', () => {
    const base = seedMessages(JID, 5);
    const lastTs = new Date(base + 4 * 60_000).toISOString();

    const result = getMessageContext(JID, lastTs, 2, 5);

    expect(result.anchor!.content).toBe('消息 #4');
    expect(result.after).toHaveLength(0);
    expect(result.before).toHaveLength(2);
  });

  it('空聊天记录返回 null anchor', () => {
    storeChatMetadata(JID, '2024-01-01T00:00:00.000Z');
    const result = getMessageContext(JID, '2024-06-01T10:05:00.000Z');

    expect(result.anchor).toBeNull();
    expect(result.before).toHaveLength(0);
    expect(result.after).toHaveLength(0);
  });

  it('不同 chat_jid 之间互不干扰', () => {
    seedMessages('group-a@g.us', 5);
    seedMessages('group-b@g.us', 3);

    const base = new Date('2024-06-01T10:00:00.000Z').getTime();
    const ts = new Date(base + 2 * 60_000).toISOString();

    const resultA = getMessageContext('group-a@g.us', ts, 5, 5);
    const resultB = getMessageContext('group-b@g.us', ts, 5, 5);

    expect(resultA.anchor!.content).toBe('消息 #2');
    expect(resultA.before).toHaveLength(2);
    expect(resultA.after).toHaveLength(2);

    expect(resultB.anchor!.content).toBe('消息 #2');
    expect(resultB.before).toHaveLength(2);
    expect(resultB.after).toHaveLength(0); // group-b 只有 3 条
  });

  it('默认前后各 5 条', () => {
    seedMessages(JID, 20);
    const base = new Date('2024-06-01T10:00:00.000Z').getTime();
    const ts = new Date(base + 10 * 60_000).toISOString();

    const result = getMessageContext(JID, ts);

    expect(result.anchor!.content).toBe('消息 #10');
    expect(result.before).toHaveLength(5);
    expect(result.after).toHaveLength(5);
  });

  it('空内容消息被过滤', () => {
    storeChatMetadata(JID, '2024-06-01T10:00:00.000Z');
    const base = new Date('2024-06-01T10:00:00.000Z').getTime();

    for (let i = 0; i < 5; i++) {
      storeMessage({
        id: `empty-${i}`,
        chat_jid: JID,
        sender: 'alice@s',
        sender_name: 'Alice',
        content: i === 2 ? '' : `消息 #${i}`,
        timestamp: new Date(base + i * 60_000).toISOString(),
        is_from_me: false,
      });
    }

    // 锚点 msg-3，before 应跳过空的 msg-2
    const ts = new Date(base + 3 * 60_000).toISOString();
    const result = getMessageContext(JID, ts, 3, 3);

    expect(result.anchor!.content).toBe('消息 #3');
    expect(result.before.map((m) => m.content)).toEqual(['消息 #0', '消息 #1']);
    expect(result.after).toHaveLength(1); // 只有 msg-4
  });

  it('默认过滤 tool_call 进度，锚点会命中最近的有效消息', () => {
    storeChatMetadata(JID, '2024-06-01T10:00:00.000Z');
    const base = new Date('2024-06-01T10:00:00.000Z').getTime();
    storeMessageDirect({
      id: 'ctx-user',
      chat_jid: JID,
      sender: 'u@s',
      sender_name: 'User',
      content: '用户消息',
      timestamp: new Date(base).toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });
    storeMessageDirect({
      id: 'tool_ctx',
      chat_jid: JID,
      sender: 'bot@s',
      sender_name: 'Bot',
      content: '🔧 Bash: ls',
      timestamp: new Date(base + 60_000).toISOString(),
      is_from_me: true,
      is_bot_message: true,
    });
    storeMessageDirect({
      id: 'ctx-result',
      chat_jid: JID,
      sender: 'bot@s',
      sender_name: 'Bot',
      content: '最终结果',
      timestamp: new Date(base + 180_000).toISOString(),
      is_from_me: true,
      is_bot_message: true,
    });

    const result = getMessageContext(
      JID,
      new Date(base + 60_000).toISOString(),
      5,
      5,
    );

    expect(result.anchor!.content).toBe('用户消息');
    expect(result.after.map((m) => m.content)).toEqual(['最终结果']);
  });

  it('includeToolCalls=true 时按时间戳上下文保留 tool_call 进度', () => {
    storeChatMetadata(JID, '2024-06-01T10:00:00.000Z');
    const base = new Date('2024-06-01T10:00:00.000Z').getTime();
    storeMessageDirect({
      id: 'ctx-user-all',
      chat_jid: JID,
      sender: 'u@s',
      sender_name: 'User',
      content: '用户消息',
      timestamp: new Date(base).toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });
    storeMessageDirect({
      id: 'tool_ctx_all',
      chat_jid: JID,
      sender: 'bot@s',
      sender_name: 'Bot',
      content: '🔧 Bash: ls',
      timestamp: new Date(base + 60_000).toISOString(),
      is_from_me: true,
      is_bot_message: true,
    });

    const result = getMessageContext(
      JID,
      new Date(base + 60_000).toISOString(),
      5,
      5,
      true,
    );

    expect(result.anchor!.content).toBe('🔧 Bash: ls');
    expect(result.before.map((m) => m.content)).toEqual(['用户消息']);
  });

  it('before 按时间正序排列', () => {
    seedMessages(JID, 10);
    const base = new Date('2024-06-01T10:00:00.000Z').getTime();
    const ts = new Date(base + 7 * 60_000).toISOString();

    const result = getMessageContext(JID, ts, 5, 0);

    for (let i = 1; i < result.before.length; i++) {
      expect(result.before[i].timestamp > result.before[i - 1].timestamp).toBe(
        true,
      );
    }
  });
});

// --- getMessageContextById ---

describe('getMessageContextById', () => {
  const JID = 'test-byid@g.us';

  it('按 ID 命中，返回前后各 N 条', () => {
    seedMessages(JID, 11); // ctx-{JID}-0 ~ ctx-{JID}-10

    const result = getMessageContextById(`ctx-${JID}-5`, 3, 3);

    expect(result.anchor).not.toBeNull();
    expect(result.anchor!.content).toBe('消息 #5');
    expect(result.before.map((m) => m.content)).toEqual([
      '消息 #2',
      '消息 #3',
      '消息 #4',
    ]);
    expect(result.after.map((m) => m.content)).toEqual([
      '消息 #6',
      '消息 #7',
      '消息 #8',
    ]);
  });

  it('ID 不存在返回 null anchor，不抛异常', () => {
    seedMessages(JID, 5);

    const result = getMessageContextById('nonexistent-id', 3, 3);

    expect(result.anchor).toBeNull();
    expect(result.before).toHaveLength(0);
    expect(result.after).toHaveLength(0);
  });

  it('不传 before/after 用默认值 5', () => {
    seedMessages(JID, 20);

    const result = getMessageContextById(`ctx-${JID}-10`);

    expect(result.anchor!.content).toBe('消息 #10');
    expect(result.before).toHaveLength(5);
    expect(result.after).toHaveLength(5);
  });

  it('锚点是会话最早一条时 before 为空，不跨会话', () => {
    seedMessages(JID, 5);
    seedMessages('other@g.us', 5); // 另一个会话不应混入

    const result = getMessageContextById(`ctx-${JID}-0`, 5, 2);

    expect(result.anchor!.content).toBe('消息 #0');
    expect(result.before).toHaveLength(0);
    expect(result.after).toHaveLength(2);
  });

  it('上下文包含普通 bot 回复，但默认过滤 tool_call 进度', () => {
    storeChatMetadata(JID, '2024-06-01T10:00:00.000Z');
    const base = new Date('2024-06-01T10:00:00.000Z').getTime();
    // 0: 用户  1: tool_call 进度  2: bot 回复  3: 用户(锚点)  4: bot 回复
    storeMessageDirect({
      id: 'm0',
      chat_jid: JID,
      sender: 'u@s',
      sender_name: 'User',
      content: '问题',
      timestamp: new Date(base).toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });
    storeMessageDirect({
      id: 'tool_1',
      chat_jid: JID,
      sender: 'bot@s',
      sender_name: 'Bot',
      content: '🔧 Bash: ls',
      timestamp: new Date(base + 60_000).toISOString(),
      is_from_me: true,
      is_bot_message: true,
    });
    storeMessageDirect({
      id: 'm1',
      chat_jid: JID,
      sender: 'bot@s',
      sender_name: 'Bot',
      content: 'bot 回复 A',
      timestamp: new Date(base + 120_000).toISOString(),
      is_from_me: true,
      is_bot_message: true,
    });
    storeMessageDirect({
      id: 'm2',
      chat_jid: JID,
      sender: 'u@s',
      sender_name: 'User',
      content: '锚点',
      timestamp: new Date(base + 180_000).toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });
    storeMessageDirect({
      id: 'm3',
      chat_jid: JID,
      sender: 'bot@s',
      sender_name: 'Bot',
      content: 'bot 回复 B',
      timestamp: new Date(base + 240_000).toISOString(),
      is_from_me: true,
      is_bot_message: true,
    });

    const result = getMessageContextById('m2', 5, 5);

    expect(result.anchor!.content).toBe('锚点');
    expect(result.before.map((m) => m.content)).toEqual(['问题', 'bot 回复 A']);
    expect(result.after.map((m) => m.content)).toEqual(['bot 回复 B']);
  });

  it('includeToolCalls=true 时上下文保留 tool_call 进度', () => {
    storeChatMetadata(JID, '2024-06-01T10:00:00.000Z');
    const base = new Date('2024-06-01T10:00:00.000Z').getTime();
    storeMessageDirect({
      id: 'm0-all',
      chat_jid: JID,
      sender: 'u@s',
      sender_name: 'User',
      content: '问题',
      timestamp: new Date(base).toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });
    storeMessageDirect({
      id: 'tool_all',
      chat_jid: JID,
      sender: 'bot@s',
      sender_name: 'Bot',
      content: '🔧 Bash: ls',
      timestamp: new Date(base + 60_000).toISOString(),
      is_from_me: true,
      is_bot_message: true,
    });
    storeMessageDirect({
      id: 'm1-all',
      chat_jid: JID,
      sender: 'u@s',
      sender_name: 'User',
      content: '锚点',
      timestamp: new Date(base + 120_000).toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });

    const result = getMessageContextById('m1-all', 5, 5, true);

    expect(result.before.map((m) => m.content)).toEqual([
      '问题',
      '🔧 Bash: ls',
    ]);
  });
});

// --- getMessageRange ---

describe('getMessageRange', () => {
  const JID = 'test-range@g.us';

  it('offset=0 取最近 N 条，正序返回', () => {
    seedMessages(JID, 10); // #0(最早) ~ #9(最新)

    const result = getMessageRange(JID, 0, 5);

    expect(result.map((m) => m.content)).toEqual([
      '消息 #5',
      '消息 #6',
      '消息 #7',
      '消息 #8',
      '消息 #9',
    ]);
  });

  it('翻页：offset=5 取更早的区间', () => {
    seedMessages(JID, 10);

    const result = getMessageRange(JID, 5, 5);

    expect(result.map((m) => m.content)).toEqual([
      '消息 #0',
      '消息 #1',
      '消息 #2',
      '消息 #3',
      '消息 #4',
    ]);
  });

  it('offset 超过总数返回空', () => {
    seedMessages(JID, 5);

    expect(getMessageRange(JID, 100, 10)).toHaveLength(0);
  });

  it('不存在的 chat_jid 返回空', () => {
    seedMessages(JID, 5);

    expect(getMessageRange('no-such@g.us', 0, 10)).toHaveLength(0);
  });

  it('空内容消息不计入区间序列', () => {
    storeChatMetadata(JID, '2024-06-01T10:00:00.000Z');
    const base = new Date('2024-06-01T10:00:00.000Z').getTime();
    // 5 条，其中 #2 为空
    for (let i = 0; i < 5; i++) {
      storeMessage({
        id: `r-${i}`,
        chat_jid: JID,
        sender: 'u@s',
        sender_name: 'User',
        content: i === 2 ? '' : `消息 #${i}`,
        timestamp: new Date(base + i * 60_000).toISOString(),
        is_from_me: false,
      });
    }

    const result = getMessageRange(JID, 0, 10);

    // 空的 #2 被排除，只剩 4 条非空
    expect(result.map((m) => m.content)).toEqual([
      '消息 #0',
      '消息 #1',
      '消息 #3',
      '消息 #4',
    ]);
  });

  it('包含普通 bot 回复，默认过滤 tool_call 进度', () => {
    storeChatMetadata(JID, '2024-06-01T10:00:00.000Z');
    const base = new Date('2024-06-01T10:00:00.000Z').getTime();
    storeMessageDirect({
      id: 'b0',
      chat_jid: JID,
      sender: 'u@s',
      sender_name: 'User',
      content: '用户消息',
      timestamp: new Date(base).toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });
    storeMessageDirect({
      id: 'tool_b1',
      chat_jid: JID,
      sender: 'bot@s',
      sender_name: 'Bot',
      content: '🔧 Bash: pwd',
      timestamp: new Date(base + 60_000).toISOString(),
      is_from_me: true,
      is_bot_message: true,
    });
    storeMessageDirect({
      id: 'b1',
      chat_jid: JID,
      sender: 'bot@s',
      sender_name: 'Bot',
      content: 'bot 消息',
      timestamp: new Date(base + 120_000).toISOString(),
      is_from_me: true,
      is_bot_message: true,
    });

    const result = getMessageRange(JID, 0, 10);

    expect(result.map((m) => m.content)).toEqual(['用户消息', 'bot 消息']);
  });

  it('includeToolCalls=true 时区间查询保留 tool_call 进度', () => {
    storeChatMetadata(JID, '2024-06-01T10:00:00.000Z');
    const base = new Date('2024-06-01T10:00:00.000Z').getTime();
    storeMessageDirect({
      id: 'range-u',
      chat_jid: JID,
      sender: 'u@s',
      sender_name: 'User',
      content: '用户消息',
      timestamp: new Date(base).toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });
    storeMessageDirect({
      id: 'tool_range',
      chat_jid: JID,
      sender: 'bot@s',
      sender_name: 'Bot',
      content: '🔧 Bash: pwd',
      timestamp: new Date(base + 60_000).toISOString(),
      is_from_me: true,
      is_bot_message: true,
    });

    const result = getMessageRange(JID, 0, 10, true);

    expect(result.map((m) => m.content)).toEqual(['用户消息', '🔧 Bash: pwd']);
  });

  it('结果按时间正序', () => {
    seedMessages(JID, 8);

    const result = getMessageRange(JID, 0, 8);

    for (let i = 1; i < result.length; i++) {
      expect(result[i].timestamp > result[i - 1].timestamp).toBe(true);
    }
  });
});

// --- clampRangeParams ---

describe('clampRangeParams', () => {
  it('offset 负值钳制为 0', () => {
    expect(clampRangeParams(-5, 10)).toEqual({ offset: 0, limit: 10 });
  });

  it('limit 超上限钳制为 200', () => {
    expect(clampRangeParams(0, 10000)).toEqual({ offset: 0, limit: 200 });
  });

  it('limit 下限为 1', () => {
    expect(clampRangeParams(0, 0)).toEqual({ offset: 0, limit: 1 });
  });

  it('未传参数用默认 offset=0、limit=20', () => {
    expect(clampRangeParams()).toEqual({ offset: 0, limit: 20 });
  });

  it('小数被取整', () => {
    expect(clampRangeParams(2.7, 5.9)).toEqual({ offset: 2, limit: 5 });
  });
});
