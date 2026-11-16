/**
 * Thread history read back from the platform, through the REAL routeInbound
 * path: a fake channel adapter that can read history, the real central DB,
 * and real session mailboxes on disk.
 */
import fs from 'fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, ChannelDefaults, HistoryLine } from '../../channels/adapter.js';
import {
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  getDb,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { findSessionForAgent } from '../../db/sessions.js';
import { inboundDbPath, sessionMailboxPath } from '../../mailbox/sqlite/paths.js';
import { routeInbound } from '../../router.js';
import type { MessagingGroupAgent } from '../../types.js';
import { addMember } from '../permissions/db/agent-group-members.js';
import { getUser, upsertUser } from '../permissions/db/users.js';
import { settleEchoFans } from './fan.js';
import { backfillPlatformHistory } from './platform-history.js';

const TEST_DIR = '/tmp/nanoclaw-test-platform-history';
const flags = vi.hoisted(() => ({ on: true }));

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));
vi.mock('../../config.js', async () => ({
  ...(await vi.importActual<object>('../../config.js')),
  DATA_DIR: '/tmp/nanoclaw-test-platform-history',
  get PLATFORM_HISTORY() {
    return flags.on;
  },
}));
vi.mock('./config.js', async () => ({
  ...(await vi.importActual<object>('./config.js')),
  PLATFORM_HISTORY_BUDGET_MS: 50,
}));

const readHistory =
  vi.fn<(platformId: string, threadId: string, options: { limit: number }) => Promise<HistoryLine[]>>();

const channelDefaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'public' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'strict' },
  mentions: 'platform',
};

function makeAdapter(): ChannelAdapter {
  return {
    name: 'testchat',
    channelType: 'testchat',
    supportsThreads: true,
    defaults: channelDefaults,
    setup: async () => {},
    teardown: async () => {},
    isConnected: () => true,
    deliver: async () => undefined,
    readHistory: (platformId, threadId, options) => readHistory(platformId, threadId, options),
  };
}

const T0 = Date.now() - 60 * 60 * 1000;
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const THREAD = 'testchat:C1:100';

function line(id: string, minutes: number, text: string, over: Partial<HistoryLine> = {}): HistoryLine {
  return {
    id,
    timestamp: at(minutes),
    senderId: 'U2',
    senderName: 'Dana',
    text,
    isBot: false,
    isSelf: false,
    ...over,
  };
}

async function seed(
  options: {
    isGroup?: 0 | 1;
    platformId?: string;
    engageMode?: MessagingGroupAgent['engage_mode'];
    engagePattern?: string;
    ignoredMessagePolicy?: 'drop' | 'accumulate';
    unknownSenderPolicy?: 'strict' | 'public';
  } = {},
): Promise<void> {
  await createAgentGroup({ id: 'ag-1', name: 'Pip', folder: 'pip', agent_provider: null, created_at: at(0) });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'testchat',
    platform_id: options.platformId ?? 'testchat:C1',
    instance: 'testchat',
    name: 'Team room',
    is_group: options.isGroup ?? 1,
    unknown_sender_policy: options.unknownSenderPolicy ?? 'public',
    created_at: at(0),
  });
  await createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: options.engageMode ?? 'mention',
    engage_pattern: options.engagePattern ?? null,
    sender_scope: 'all',
    ignored_message_policy: options.ignoredMessagePolicy ?? 'drop',
    session_mode: 'per-thread',
    priority: 0,
    threads: 1,
    created_at: at(0),
  });
  registerChannelAdapter('testchat', { factory: () => makeAdapter(), defaults: channelDefaults });
  await initChannelAdapters(() => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
}

async function send(
  id: string,
  minutes: number,
  options: { threadId?: string; isMention?: boolean; platformId?: string; isGroup?: boolean } = {},
): Promise<void> {
  await routeInbound({
    channelType: 'testchat',
    platformId: options.platformId ?? 'testchat:C1',
    threadId: options.threadId ?? THREAD,
    message: {
      id,
      kind: 'chat-sdk',
      content: JSON.stringify({ sender: 'Alex', senderId: 'U1', text: `message ${id}` }),
      timestamp: at(minutes),
      isMention: options.isMention ?? true,
      isGroup: options.isGroup ?? true,
    },
  });
}

interface Row {
  id: string;
  channel_type: string | null;
  trigger: number;
  content: string;
}

async function sessionId(threadId = THREAD): Promise<string> {
  const session = await findSessionForAgent('ag-1', 'mg-1', threadId);
  if (!session) throw new Error(`no session for ${threadId}`);
  return session.id;
}

async function rows(threadId = THREAD): Promise<Row[]> {
  const db = new Database(inboundDbPath('ag-1', await sessionId(threadId)), { readonly: true });
  try {
    return db.prepare('SELECT id, channel_type, trigger, content FROM messages_in ORDER BY seq').all() as Row[];
  } finally {
    db.close();
  }
}

function blocks(all: Row[]): Array<{ lines: Array<{ sender: string; text: string; self?: boolean }> }> {
  return all.map((r) => JSON.parse(r.content)).filter((c) => c.echo?.surface === 'thread-history');
}

beforeEach(async () => {
  flags.on = true;
  readHistory.mockReset();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await settleEchoFans();
  await teardownChannelAdapters();
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('thread history read from the platform', () => {
  it('with the switch off reads nothing and writes only the trigger', async () => {
    flags.on = false;
    await seed();
    readHistory.mockResolvedValue([line('L1', 1, 'earlier')]);

    await send('m1', 5);

    expect(readHistory).not.toHaveBeenCalled();
    expect((await rows()).map((r) => r.id)).toEqual(['m1:ag-1']);
  });

  it('gives a new thread session the earlier lines as ONE row before the trigger', async () => {
    await seed();
    readHistory.mockResolvedValue([
      line('L1', 1, 'the deploy failed again'),
      line('L2', 2, 'same error as Monday', { senderId: 'U3', senderName: 'Lee' }),
      line('m1', 5, 'message m1', { senderId: 'U1', senderName: 'Alex' }),
      line('L4', 6, 'posted after the tag'),
    ]);

    await send('m1', 5);

    expect(readHistory).toHaveBeenCalledWith('testchat:C1', THREAD, { limit: 101 });
    const all = await rows();
    expect(all.map((r) => r.trigger)).toEqual([0, 1]);
    expect(all[0].channel_type).toBe('session-echo');
    expect(all[1].id).toBe('m1:ag-1');
    expect(blocks(all)[0].lines.map((l) => `${l.sender}: ${l.text}`)).toEqual([
      'Dana: the deploy failed again',
      'Lee: same error as Monday',
    ]);
  });

  it('on a later tag carries only the lines the session has not seen', async () => {
    await seed();
    readHistory.mockResolvedValueOnce([line('L1', 1, 'first')]);
    await send('m1', 5);

    // A copy from another thread lands later; it must not hide this thread's lines.
    const db = new Database(inboundDbPath('ag-1', await sessionId()));
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, channel_type, content, trigger)
       VALUES ('echo-1', 100, 'chat', ?, 'pending', 'session-echo', ?, 0)`,
    ).run(at(9), JSON.stringify({ text: 'elsewhere', echo: { surface: 'dm-thread', label: 'x' } }));
    db.close();

    readHistory.mockResolvedValueOnce([
      line('L1', 1, 'first'),
      line('m1', 5, 'message m1', { senderId: 'U1', senderName: 'Alex' }),
      line('L2', 7, 'untagged reply'),
      line('L3', 8, 'you replied', { isSelf: true, isBot: true, senderName: 'Pip' }),
      line('L4', 10, 'another untagged reply'),
      line('m2', 12, 'message m2', { senderId: 'U1', senderName: 'Alex' }),
    ]);
    await send('m2', 12);

    const found = blocks(await rows());
    expect(found).toHaveLength(2);
    expect(found[1].lines.map((l) => l.text)).toEqual(['untagged reply', 'you replied', 'another untagged reply']);
    expect(found[1].lines[1].self).toBe(true);
  });

  it('does not read when every message of the thread already reaches the session', async () => {
    await seed({ engageMode: 'mention-sticky' });
    readHistory.mockResolvedValue([]);

    await send('m1', 5); // creates the session: one read
    await send('m2', 6, { isMention: false }); // sticky follow-up: no read

    expect(readHistory).toHaveBeenCalledTimes(1);
  });

  it('falls back when the read runs past its budget, and a second tag does not start another read', async () => {
    await seed();
    let finish: (lines: HistoryLine[]) => void = () => {};
    readHistory.mockReturnValue(new Promise<HistoryLine[]>((resolve) => (finish = resolve)));

    await send('m1', 5);
    await send('m2', 6);

    expect((await rows()).map((r) => r.id)).toEqual(['m1:ag-1', 'm2:ag-1']);
    expect(readHistory).toHaveBeenCalledTimes(1);
    finish([]);
  });

  it('falls back when the read fails', async () => {
    await seed();
    readHistory.mockRejectedValue(new Error('platform said no'));

    await send('m1', 5);

    expect((await rows()).map((r) => r.id)).toEqual(['m1:ag-1']);
  });

  it("leaves out a line whose sender the chat's access rules refuse, and records nothing about that sender", async () => {
    await seed({ unknownSenderPolicy: 'strict' });
    await upsertUser({ id: 'testchat:U2', kind: 'testchat', display_name: 'Dana', created_at: at(0) });
    await addMember({ user_id: 'testchat:U2', agent_group_id: 'ag-1', added_by: null, added_at: at(0) });
    readHistory.mockResolvedValue([
      line('L1', 1, 'from a member'),
      line('L2', 2, 'from a stranger', { senderId: 'U9', senderName: 'Stranger' }),
      line('L3', 3, 'from the bot itself', { senderId: 'B1', isBot: true, isSelf: true }),
    ]);

    await send('m1', 5);

    expect(blocks(await rows())[0].lines.map((l) => l.text)).toEqual(['from a member', 'from the bot itself']);
    expect(await getUser('testchat:U9')).toBeUndefined();
    expect(await getDb().all("SELECT * FROM unregistered_senders WHERE user_id = 'testchat:U9'")).toHaveLength(0);
    expect(await getDb().all('SELECT * FROM pending_sender_approvals')).toHaveLength(0);
  });

  it('writes one block per trigger, so a redelivered trigger adds no second block', async () => {
    await seed();
    readHistory.mockResolvedValue([line('L1', 1, 'earlier')]);
    await send('m1', 5);
    const session = (await findSessionForAgent('ag-1', 'mg-1', THREAD))!;
    const { getAgentGroup, getMessagingGroup } = await import('../../db/index.js');
    const agentGroup = (await getAgentGroup('ag-1'))!;
    const mg = (await getMessagingGroup('mg-1'))!;

    // Redelivered after the trigger row landed: nothing newer than it to add.
    await backfillPlatformHistory(agentGroup, session, mg, {
      created: false,
      trigger: { id: 'm1', timestamp: at(5) },
    });
    // Redelivered as if the trigger row never landed: same block id, nothing added.
    const db = new Database(inboundDbPath('ag-1', session.id));
    db.prepare("DELETE FROM messages_in WHERE id = 'm1:ag-1'").run();
    db.close();
    await backfillPlatformHistory(agentGroup, session, mg, {
      created: false,
      trigger: { id: 'm1', timestamp: at(5) },
    });

    expect(blocks(await rows())).toHaveLength(1);
  });

  it("shows the agent's own top-level post once when a reply in its thread opens a new session", async () => {
    // A DM where each top-level message roots its own session.
    await seed({ isGroup: 0, platformId: 'testchat:D1', engageMode: 'pattern', engagePattern: '.' });
    readHistory.mockResolvedValue([]);
    await send('u1', 1, { platformId: 'testchat:D1', threadId: 'testchat:D1:u1', isGroup: false });

    // That session's agent posted a top-level message, delivered as platform message P1.
    const first = await sessionId('testchat:D1:u1');
    const outbound = new Database(sessionMailboxPath({ agentGroupId: 'ag-1', sessionId: first }, 'outbound'));
    outbound
      .prepare(
        `INSERT INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, thread_id, content)
         VALUES ('out-1', 1, ?, 'chat', 'testchat:D1', 'testchat', NULL, ?)`,
      )
      .run(at(2), JSON.stringify({ text: 'Want a quick tour?' }));
    outbound.close();
    const inbound = new Database(inboundDbPath('ag-1', first));
    inbound
      .prepare(
        "INSERT INTO delivered (message_out_id, platform_message_id, status, delivered_at) VALUES ('out-1', 'P1', 'delivered', ?)",
      )
      .run(at(2));
    inbound.close();

    // The user answers in that post's thread: a new session, whose thread starts with the post.
    readHistory.mockResolvedValue([
      line('P1', 2, 'Want a quick tour?', { senderName: 'Pip', isBot: true, isSelf: true }),
      line('u2', 3, 'message u2', { senderId: 'U1', senderName: 'Alex' }),
    ]);
    await send('u2', 3, { platformId: 'testchat:D1', threadId: 'testchat:D1:P1', isGroup: false });

    const all = await rows('testchat:D1:P1');
    const showingPost = all.filter((r) => r.content.includes('Want a quick tour?'));
    expect(showingPost).toHaveLength(1);
    expect(JSON.parse(showingPost[0].content).echo.surface).toBe('dm-timeline');
    expect(blocks(all)).toHaveLength(0);
  });
});
