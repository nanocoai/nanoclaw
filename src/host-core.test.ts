/**
 * Integration tests for the v2 host core.
 * Tests routing, session creation, message writing, and delivery
 * without spawning actual containers.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  initTestDb,
  closeDb,
  getDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import {
  resolveSession,
  writeSessionMessage,
  writeSessionRouting,
  initSessionFolder,
  sessionDir,
  inboundDbPath,
  outboundDbPath,
  readOutboxFiles,
  clearOutbox,
} from './session-manager.js';
import { getSession, findSession } from './db/sessions.js';
import type { InboundEvent } from './channels/adapter.js';

// Mock container runner to prevent actual Docker spawning
vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

// Override DATA_DIR for tests
vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-host' };
});

function now() {
  return new Date().toISOString();
}

const TEST_DIR = '/tmp/nanoclaw-test-host';

beforeEach(() => {
  // Clean test directory
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('session manager', () => {
  beforeEach(() => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Test Agent',
      folder: 'test-agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'chan-123',
      name: 'General',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
  });

  it('should create session folder and both DBs', () => {
    initSessionFolder('ag-1', 'sess-test');
    const dir = sessionDir('ag-1', 'sess-test');
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'outbox'))).toBe(true);

    // Verify inbound.db
    const inPath = inboundDbPath('ag-1', 'sess-test');
    expect(fs.existsSync(inPath)).toBe(true);
    const inDb = new Database(inPath);
    const inTables = inDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(inTables.map((t) => t.name)).toContain('messages_in');
    expect(inTables.map((t) => t.name)).toContain('delivered');
    inDb.close();

    // Verify outbound.db
    const outPath = outboundDbPath('ag-1', 'sess-test');
    expect(fs.existsSync(outPath)).toBe(true);
    const outDb = new Database(outPath);
    const outTables = outDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
      name: string;
    }>;
    expect(outTables.map((t) => t.name)).toContain('messages_out');
    expect(outTables.map((t) => t.name)).toContain('processing_ack');
    outDb.close();
  });

  it('should reject outbound attachment filenames that escape the message outbox', () => {
    initSessionFolder('ag-1', 'sess-test');
    const dir = sessionDir('ag-1', 'sess-test');
    const msgOutbox = path.join(dir, 'outbox', 'msg-1');
    fs.mkdirSync(msgOutbox, { recursive: true });

    const outside = path.join(TEST_DIR, 'outside.txt');
    fs.writeFileSync(outside, 'outside secret');

    expect(readOutboxFiles('ag-1', 'sess-test', 'msg-1', ['../../../../../outside.txt'])).toBeUndefined();
  });

  it('should reject outbound attachment symlinks that escape the message outbox', () => {
    initSessionFolder('ag-1', 'sess-test');
    const dir = sessionDir('ag-1', 'sess-test');
    const msgOutbox = path.join(dir, 'outbox', 'msg-1');
    fs.mkdirSync(msgOutbox, { recursive: true });

    const outside = path.join(TEST_DIR, 'outside.txt');
    fs.writeFileSync(outside, 'outside secret');
    fs.symlinkSync('../../../../../outside.txt', path.join(msgOutbox, 'safe-name.txt'));

    expect(readOutboxFiles('ag-1', 'sess-test', 'msg-1', ['safe-name.txt'])).toBeUndefined();
  });

  it('should not recursively delete outside the outbox for unsafe message ids', () => {
    initSessionFolder('ag-1', 'sess-test');
    const victimDir = path.join(TEST_DIR, 'victim-dir');
    fs.mkdirSync(victimDir, { recursive: true });
    fs.writeFileSync(path.join(victimDir, 'keep.txt'), 'do not delete');

    clearOutbox('ag-1', 'sess-test', '../../../../victim-dir');

    expect(fs.existsSync(path.join(victimDir, 'keep.txt'))).toBe(true);
  });

  it('should still read and clear normal basename outbox files', () => {
    initSessionFolder('ag-1', 'sess-test');
    const dir = sessionDir('ag-1', 'sess-test');
    const msgOutbox = path.join(dir, 'outbox', 'msg-1');
    fs.mkdirSync(msgOutbox, { recursive: true });
    fs.writeFileSync(path.join(msgOutbox, 'result.txt'), 'ok');

    const files = readOutboxFiles('ag-1', 'sess-test', 'msg-1', ['result.txt']);
    expect(files).toHaveLength(1);
    expect(files?.[0]?.filename).toBe('result.txt');
    expect(files?.[0]?.data.toString()).toBe('ok');

    clearOutbox('ag-1', 'sess-test', 'msg-1');
    expect(fs.existsSync(msgOutbox)).toBe(false);
  });

  it('should reject inbound attachment writes through a pre-placed symlinked inbox dir', () => {
    initSessionFolder('ag-1', 'sess-test');
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    // The container has /workspace write access, so it can pre create
    // inbox/<msgId> as a symlink to escape.
    const inboxRoot = path.join(sessionDir('ag-1', session.id), 'inbox');
    fs.mkdirSync(inboxRoot, { recursive: true });
    const evilTarget = path.join(TEST_DIR, 'evil-target');
    fs.mkdirSync(evilTarget, { recursive: true });
    fs.symlinkSync(evilTarget, path.join(inboxRoot, 'msg-evil'));

    writeSessionMessage('ag-1', session.id, {
      id: 'msg-evil',
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({
        text: 'evil',
        attachments: [{ name: 'photo.png', data: Buffer.from('PNGBYTES').toString('base64'), size: 8 }],
      }),
    });

    expect(fs.existsSync(path.join(evilTarget, 'photo.png'))).toBe(false);
  });

  it('should refuse to follow a pre-existing symlink at the inbound attachment path', () => {
    initSessionFolder('ag-1', 'sess-test');
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    // The container pre creates inbox/<msgId>/photo.png as a symlink to a
    // host file. Without the wx flag, writeFileSync would follow it.
    const inboxDir = path.join(sessionDir('ag-1', session.id), 'inbox', 'msg-sym');
    fs.mkdirSync(inboxDir, { recursive: true });
    const outside = path.join(TEST_DIR, 'outside.txt');
    fs.writeFileSync(outside, 'ORIGINAL');
    fs.symlinkSync(outside, path.join(inboxDir, 'photo.png'));

    writeSessionMessage('ag-1', session.id, {
      id: 'msg-sym',
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({
        text: 'sym',
        attachments: [{ name: 'photo.png', data: Buffer.from('PNGBYTES').toString('base64'), size: 8 }],
      }),
    });

    expect(fs.readFileSync(outside, 'utf-8')).toBe('ORIGINAL');
  });

  it('should reject inbound attachments when messageId is unsafe', () => {
    initSessionFolder('ag-1', 'sess-test');
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    writeSessionMessage('ag-1', session.id, {
      id: '../../escape',
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({
        text: 'msgid',
        attachments: [{ name: 'photo.png', data: Buffer.from('PNGBYTES').toString('base64'), size: 8 }],
      }),
    });

    const inboxRoot = path.join(sessionDir('ag-1', session.id), 'inbox');
    if (fs.existsSync(inboxRoot)) {
      expect(fs.readdirSync(inboxRoot)).toEqual([]);
    }
  });

  it('should still save inbound attachments with safe basenames', () => {
    initSessionFolder('ag-1', 'sess-test');
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    writeSessionMessage('ag-1', session.id, {
      id: 'msg-ok',
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({
        text: 'ok',
        attachments: [{ name: 'photo.png', data: Buffer.from('PNGBYTES').toString('base64'), size: 8 }],
      }),
    });

    const expected = path.join(sessionDir('ag-1', session.id), 'inbox', 'msg-ok', 'photo.png');
    expect(fs.existsSync(expected)).toBe(true);
    expect(fs.readFileSync(expected, 'utf-8')).toBe('PNGBYTES');
  });

  it('should resolve to existing session (shared mode)', () => {
    const { session: s1, created: c1 } = resolveSession('ag-1', 'mg-1', null, 'shared');
    expect(c1).toBe(true);

    const { session: s2, created: c2 } = resolveSession('ag-1', 'mg-1', null, 'shared');
    expect(c2).toBe(false);
    expect(s2.id).toBe(s1.id);
  });

  it('should create separate sessions per thread (per-thread mode)', () => {
    const { session: s1 } = resolveSession('ag-1', 'mg-1', 'thread-1', 'per-thread');
    const { session: s2 } = resolveSession('ag-1', 'mg-1', 'thread-2', 'per-thread');
    expect(s1.id).not.toBe(s2.id);
  });

  it('should reuse session for same thread', () => {
    const { session: s1 } = resolveSession('ag-1', 'mg-1', 'thread-1', 'per-thread');
    const { session: s2, created } = resolveSession('ag-1', 'mg-1', 'thread-1', 'per-thread');
    expect(created).toBe(false);
    expect(s2.id).toBe(s1.id);
  });

  it('should write message to inbound DB', () => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    writeSessionMessage('ag-1', session.id, {
      id: 'msg-1',
      kind: 'chat',
      timestamp: now(),
      platformId: 'chan-123',
      channelType: 'discord',
      threadId: null,
      content: JSON.stringify({ sender: 'User', text: 'Hello' }),
    });

    // Read from the inbound DB
    const dbPath = inboundDbPath('ag-1', session.id);
    const db = new Database(dbPath);
    const rows = db.prepare('SELECT * FROM messages_in').all() as Array<{
      id: string;
      kind: string;
      status: string;
      content: string;
    }>;
    db.close();

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('msg-1');
    expect(rows[0].status).toBe('pending');
    expect(JSON.parse(rows[0].content).text).toBe('Hello');
  });

  it('should update last_active on message write', () => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    expect(getSession(session.id)!.last_active).toBeNull();

    writeSessionMessage('ag-1', session.id, {
      id: 'msg-1',
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({ text: 'hi' }),
    });

    expect(getSession(session.id)!.last_active).not.toBeNull();
  });

  it('should refuse path-traversal in attachment filenames', () => {
    // Regression: attachment.name comes from untrusted senders (E2EE-protected
    // chat platforms can't sanitize it server-side). Without the guard, a
    // `../../../tmp/pwned` filename escapes the inbox dir and writes anywhere
    // the host process can reach.
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    const inboxBase = path.join(sessionDir('ag-1', session.id), 'inbox');
    const escapeTarget = path.join('/tmp', 'nanoclaw-traversal-canary');
    if (fs.existsSync(escapeTarget)) fs.rmSync(escapeTarget);

    writeSessionMessage('ag-1', session.id, {
      id: 'msg-attack',
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({
        text: 'pwn',
        attachments: [
          {
            type: 'document',
            name: '../../../../../../../../tmp/nanoclaw-traversal-canary',
            data: Buffer.from('owned').toString('base64'),
          },
        ],
      }),
    });

    expect(fs.existsSync(escapeTarget)).toBe(false);
    // The bytes should still land — under a synthesized safe name inside the
    // inbox — so the agent doesn't lose data on a malicious filename.
    const inboxDir = path.join(inboxBase, 'msg-attack');
    expect(fs.existsSync(inboxDir)).toBe(true);
    const written = fs.readdirSync(inboxDir);
    expect(written).toHaveLength(1);
    expect(written[0]).not.toContain('/');
    expect(written[0]).not.toContain('..');
  });
});

describe('router', () => {
  beforeEach(() => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Test Agent',
      folder: 'test-agent',
      agent_provider: null,
      created_at: now(),
    });
    // Use 'public' policy so the router tests exercise routing, not the
    // access gate. Dedicated access-gate tests live with the access module.
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'chan-123',
      name: 'General',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
  });

  it('should route a message end-to-end', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');

    const event: InboundEvent = {
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: {
        id: 'msg-in-1',
        kind: 'chat',
        content: JSON.stringify({ sender: 'User', text: 'Hello agent!' }),
        timestamp: now(),
      },
    };

    await routeInbound(event);

    // Verify session was created
    const session = findSession('mg-1', null);
    expect(session).toBeDefined();

    // Verify message was written to inbound DB
    const dbPath = inboundDbPath('ag-1', session!.id);
    const db = new Database(dbPath);
    const rows = db.prepare('SELECT * FROM messages_in').all() as Array<{ id: string; content: string }>;
    db.close();

    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content).text).toBe('Hello agent!');

    // Verify container was woken
    expect(wakeContainer).toHaveBeenCalled();
  });

  it('auto-creates messaging group only when the bot is addressed (mention/DM)', async () => {
    // The router's no-mg branch is escalation-gated: plain chatter on an
    // unknown channel stays silent (no DB writes) so a bot that sits in
    // many unwired channels doesn't bloat messaging_groups. Only explicit
    // mentions and DMs trigger auto-create.
    const { routeInbound } = await import('./router.js');
    const { getMessagingGroupByPlatform } = await import('./db/messaging-groups.js');

    // Plain message on unknown channel — should NOT auto-create.
    await routeInbound({
      channelType: 'slack',
      platformId: 'C-PLAIN',
      threadId: null,
      message: {
        id: 'msg-plain',
        kind: 'chat',
        content: JSON.stringify({ sender: 'User', text: 'Hi' }),
        timestamp: now(),
      },
    });
    expect(getMessagingGroupByPlatform('slack', 'C-PLAIN')).toBeUndefined();

    // Mention on unknown channel — SHOULD auto-create (next step: channel-registration flow).
    await routeInbound({
      channelType: 'slack',
      platformId: 'C-MENTIONED',
      threadId: null,
      message: {
        id: 'msg-mentioned',
        kind: 'chat',
        content: JSON.stringify({ sender: 'User', text: '@bot hi' }),
        timestamp: now(),
        isMention: true,
      },
    });
    expect(getMessagingGroupByPlatform('slack', 'C-MENTIONED')).toBeDefined();
  });

  it('should route multiple messages to the same session', async () => {
    const { routeInbound } = await import('./router.js');

    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: { id: 'msg-a', kind: 'chat', content: JSON.stringify({ sender: 'A', text: 'First' }), timestamp: now() },
    });

    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: {
        id: 'msg-b',
        kind: 'chat',
        content: JSON.stringify({ sender: 'B', text: 'Second' }),
        timestamp: now(),
      },
    });

    // Both should be in the same session
    const session = findSession('mg-1', null);
    const dbPath = inboundDbPath('ag-1', session!.id);
    const db = new Database(dbPath);
    const rows = db.prepare('SELECT * FROM messages_in ORDER BY timestamp').all();
    db.close();

    expect(rows).toHaveLength(2);
  });

  it('fans out to every matching agent, each in its own session', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    // Wire a second agent to the same messaging group.
    createAgentGroup({
      id: 'ag-2',
      name: 'Secondary Agent',
      folder: 'secondary-agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-2',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-2',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });

    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: { id: 'msg-fan', kind: 'chat', content: JSON.stringify({ text: 'hello all' }), timestamp: now() },
    });

    // Both agents should now have their own session and be woken.
    expect(wakeContainer).toHaveBeenCalledTimes(2);

    const { getSessionsByAgentGroup } = await import('./db/sessions.js');
    expect(getSessionsByAgentGroup('ag-1')).toHaveLength(1);
    expect(getSessionsByAgentGroup('ag-2')).toHaveLength(1);
  });

  it('accumulates without waking when engage fails + ignored_message_policy=accumulate', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    // Replace the seed row with a mention-only wiring whose accumulate
    // policy should store context even when the message doesn't mention us.
    const { updateMessagingGroupAgent } = await import('./db/messaging-groups.js');
    updateMessagingGroupAgent('mga-1', {
      engage_mode: 'mention',
      ignored_message_policy: 'accumulate',
    });

    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: {
        id: 'msg-nomatch',
        kind: 'chat',
        content: JSON.stringify({ text: 'no mention here' }),
        timestamp: now(),
      },
    });

    expect(wakeContainer).not.toHaveBeenCalled();

    const session = findSession('mg-1', null);
    expect(session).toBeDefined();
    const db = new Database(inboundDbPath('ag-1', session!.id));
    const rows = db.prepare('SELECT id, trigger FROM messages_in').all() as Array<{
      id: string;
      trigger: number;
    }>;
    db.close();
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger).toBe(0);
  });

  it('drops silently when engage fails + ignored_message_policy=drop', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    const { updateMessagingGroupAgent } = await import('./db/messaging-groups.js');
    updateMessagingGroupAgent('mga-1', { engage_mode: 'mention' }); // drop is the default

    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: { id: 'msg-drop', kind: 'chat', content: JSON.stringify({ text: 'ignored' }), timestamp: now() },
    });

    expect(wakeContainer).not.toHaveBeenCalled();
    // No session should have been created for this agent.
    expect(findSession('mg-1', null)).toBeUndefined();
  });
});

describe('router — channel instances', () => {
  beforeEach(() => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Default Bot',
      folder: 'default-bot',
      agent_provider: null,
      created_at: now(),
    });
    createAgentGroup({
      id: 'ag-2',
      name: 'Tester Bot',
      folder: 'tester-bot',
      agent_provider: null,
      created_at: now(),
    });
    // Two messaging groups on the SAME (channel_type, platform_id), owned
    // by different adapter instances and wired to different agents.
    createMessagingGroup({
      id: 'mg-default',
      channel_type: 'slack',
      platform_id: 'slack:C1',
      name: 'Default chat',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-tester',
      channel_type: 'slack',
      platform_id: 'slack:C1',
      instance: 'slack-tester',
      name: 'Tester chat',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    for (const [mgaId, mgId, agId] of [
      ['mga-default', 'mg-default', 'ag-1'],
      ['mga-tester', 'mg-tester', 'ag-2'],
    ] as const) {
      createMessagingGroupAgent({
        id: mgaId,
        messaging_group_id: mgId,
        agent_group_id: agId,
        engage_mode: 'pattern',
        engage_pattern: '.',
        sender_scope: 'all',
        ignored_message_policy: 'drop',
        session_mode: 'shared',
        priority: 0,
        created_at: now(),
      });
    }
  });

  it('routes by receiving instance: named instance lands in its own mg/agent, default in the default', async () => {
    const { routeInbound } = await import('./router.js');
    const { registerChannelAdapter, initChannelAdapters, teardownChannelAdapters } =
      await import('./channels/channel-registry.js');
    const { getSessionsByAgentGroup } = await import('./db/sessions.js');

    // Default 'slack' adapter is THREADED; the named instance is NOT.
    // The same arm therefore also pins the thread-policy lookup at the
    // receiving instance: if the router resolved the adapter by
    // channelType, the tester event's threadId would survive.
    const makeAdapter = (instance: string | undefined, supportsThreads: boolean) => ({
      name: instance ?? 'slack',
      channelType: 'slack',
      instance,
      supportsThreads,
      async setup() {},
      async teardown() {},
      isConnected: () => true,
      async deliver() {
        return undefined;
      },
    });
    registerChannelAdapter('slack', { factory: () => makeAdapter(undefined, true) });
    registerChannelAdapter('slack-tester', { factory: () => makeAdapter('slack-tester', false) });
    await initChannelAdapters(() => ({
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    }));

    try {
      // Inbound on the named instance, with a threadId the non-threaded
      // adapter must collapse.
      await routeInbound({
        channelType: 'slack',
        instance: 'slack-tester',
        platformId: 'slack:C1',
        threadId: 'thread-9',
        message: {
          id: 'msg-tester',
          kind: 'chat',
          content: JSON.stringify({ sender: 'U', text: 'to tester' }),
          timestamp: now(),
        },
      });

      const testerSessions = getSessionsByAgentGroup('ag-2');
      expect(testerSessions).toHaveLength(1);
      expect(testerSessions[0].messaging_group_id).toBe('mg-tester');
      expect(getSessionsByAgentGroup('ag-1')).toHaveLength(0);

      const tDb = new Database(inboundDbPath('ag-2', testerSessions[0].id));
      const tRow = tDb.prepare('SELECT thread_id, content FROM messages_in').get() as {
        thread_id: string | null;
        content: string;
      };
      tDb.close();
      expect(JSON.parse(tRow.content).text).toBe('to tester');
      // Collapsed by the named instance's thread policy.
      expect(tRow.thread_id).toBeNull();

      // Same address, no instance ⇒ default instance ⇒ default mg/agent,
      // and the default adapter is threaded so the threadId survives.
      await routeInbound({
        channelType: 'slack',
        platformId: 'slack:C1',
        threadId: 'thread-9',
        message: {
          id: 'msg-default',
          kind: 'chat',
          content: JSON.stringify({ sender: 'U', text: 'to default' }),
          timestamp: now(),
        },
      });

      const defaultSessions = getSessionsByAgentGroup('ag-1');
      expect(defaultSessions).toHaveLength(1);
      expect(defaultSessions[0].messaging_group_id).toBe('mg-default');
      const dDb = new Database(inboundDbPath('ag-1', defaultSessions[0].id));
      const dRow = dDb.prepare('SELECT thread_id FROM messages_in').get() as { thread_id: string | null };
      dDb.close();
      expect(dRow.thread_id).toBe('thread-9');
    } finally {
      await teardownChannelAdapters();
    }
  });

  it('auto-create persists the receiving instance instead of hijacking the default row', async () => {
    const { routeInbound } = await import('./router.js');
    const { getMessagingGroupByPlatform } = await import('./db/messaging-groups.js');

    // No row exists for this address on ANY instance yet; create an
    // unwired default row to prove the named event doesn't reuse it.
    createMessagingGroup({
      id: 'mg-plain',
      channel_type: 'slack',
      platform_id: 'slack:C-NEW',
      name: null,
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });

    await routeInbound({
      channelType: 'slack',
      instance: 'slack-tester',
      platformId: 'slack:C-NEW',
      threadId: null,
      message: {
        id: 'msg-mention',
        kind: 'chat',
        content: JSON.stringify({ sender: 'U', text: '@tester hi' }),
        timestamp: now(),
        isMention: true,
      },
    });

    const created = getMessagingGroupByPlatform('slack', 'slack:C-NEW', 'slack-tester');
    expect(created).toBeDefined();
    expect(created!.instance).toBe('slack-tester');
    expect(created!.id).not.toBe('mg-plain');
    // The default row is untouched.
    expect(getMessagingGroupByPlatform('slack', 'slack:C-NEW', 'slack')!.id).toBe('mg-plain');
  });
});

describe('router — per-wiring thread policy', () => {
  // Slack-like threaded adapter on a unique channel type (the registry maps
  // are module-global; unique names avoid cross-test collisions).
  const makeThreadedAdapter = () => ({
    name: 'tp-slack',
    channelType: 'tp-slack',
    supportsThreads: true,
    async setup() {},
    async teardown() {},
    isConnected: () => true,
    async deliver() {
      return undefined;
    },
  });

  beforeEach(() => {
    createAgentGroup({
      id: 'ag-tp',
      name: 'Thread Agent',
      folder: 'thread-agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-tp',
      channel_type: 'tp-slack',
      platform_id: 'tp:C1',
      name: 'Threaded chat',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-tp',
      messaging_group_id: 'mg-tp',
      agent_group_id: 'ag-tp',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
  });

  async function withThreadedAdapter(fn: () => Promise<void>): Promise<void> {
    const { registerChannelAdapter, initChannelAdapters, teardownChannelAdapters } =
      await import('./channels/channel-registry.js');
    registerChannelAdapter('tp-slack', { factory: makeThreadedAdapter });
    await initChannelAdapters(() => ({
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    }));
    try {
      await fn();
    } finally {
      await teardownChannelAdapters();
    }
  }

  const threadedEvent = (id: string): InboundEvent => ({
    channelType: 'tp-slack',
    platformId: 'tp:C1',
    threadId: 'thread-42',
    message: {
      id,
      kind: 'chat',
      content: JSON.stringify({ sender: 'U', text: 'hi' }),
      timestamp: now(),
      isGroup: true,
    },
  });

  it('NULL-threads wiring (inherit) on a threaded adapter keeps thread routing as before', async () => {
    await withThreadedAdapter(async () => {
      const { routeInbound } = await import('./router.js');
      const { getSessionsByAgentGroup } = await import('./db/sessions.js');

      await routeInbound(threadedEvent('msg-null-threads'));

      // threads=NULL inherits the (fallback) declaration → supportsThreads →
      // per-thread session with the platform thread id, message addressed
      // in-thread. Identical to pre-declaration routing.
      const sessions = getSessionsByAgentGroup('ag-tp');
      expect(sessions).toHaveLength(1);
      expect(sessions[0].thread_id).toBe('thread-42');

      const db = new Database(inboundDbPath('ag-tp', sessions[0].id));
      const row = db.prepare('SELECT thread_id FROM messages_in').get() as { thread_id: string | null };
      db.close();
      expect(row.thread_id).toBe('thread-42');
    });
  });

  it('wiring threads=0 nulls the event-derived thread for session and delivery', async () => {
    getDb().prepare("UPDATE messaging_group_agents SET threads = 0 WHERE id = 'mga-tp'").run();

    await withThreadedAdapter(async () => {
      const { routeInbound } = await import('./router.js');
      const { getSessionsByAgentGroup } = await import('./db/sessions.js');

      await routeInbound(threadedEvent('msg-opt-out'));

      // Session collapses (no per-thread force, thread id stripped) and the
      // reply address is top-level.
      const sessions = getSessionsByAgentGroup('ag-tp');
      expect(sessions).toHaveLength(1);
      expect(sessions[0].thread_id).toBeNull();

      const db = new Database(inboundDbPath('ag-tp', sessions[0].id));
      const row = db.prepare('SELECT thread_id FROM messages_in').get() as { thread_id: string | null };
      db.close();
      expect(row.thread_id).toBeNull();
    });
  });

  it('wiring threads=0 never strips replyTo (operator intent)', async () => {
    getDb().prepare("UPDATE messaging_group_agents SET threads = 0 WHERE id = 'mga-tp'").run();

    await withThreadedAdapter(async () => {
      const { routeInbound } = await import('./router.js');
      const { getSessionsByAgentGroup } = await import('./db/sessions.js');

      await routeInbound({
        ...threadedEvent('msg-replyto'),
        replyTo: { channelType: 'cli', platformId: 'cli:operator', threadId: 'term-1' },
      });

      const sessions = getSessionsByAgentGroup('ag-tp');
      expect(sessions).toHaveLength(1);
      const db = new Database(inboundDbPath('ag-tp', sessions[0].id));
      const row = db.prepare('SELECT channel_type, thread_id FROM messages_in').get() as {
        channel_type: string;
        thread_id: string | null;
      };
      db.close();
      // The reply address is the operator's, thread id intact — only the
      // event-derived address is policy-stripped.
      expect(row.channel_type).toBe('cli');
      expect(row.thread_id).toBe('term-1');
    });
  });

  it('auto-create takes unknown_sender_policy from the declaration and falls back faithfully', async () => {
    const { registerChannelAdapter } = await import('./channels/channel-registry.js');
    const { routeInbound } = await import('./router.js');
    const { getMessagingGroupByPlatform } = await import('./db/messaging-groups.js');

    // Registration-tier declaration is enough — no live adapter needed.
    registerChannelAdapter('tp-declared', {
      factory: () => null,
      defaults: {
        dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
        group: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'public' },
        mentions: 'platform',
      },
    });

    const mention = (channelType: string, platformId: string, isGroup: boolean): InboundEvent => ({
      channelType,
      platformId,
      threadId: null,
      message: {
        id: `msg-${platformId}`,
        kind: 'chat',
        content: JSON.stringify({ sender: 'U', text: '@bot hi' }),
        timestamp: now(),
        isMention: true,
        isGroup,
      },
    });

    // Declared adapter: group context reads the group declaration...
    await routeInbound(mention('tp-declared', 'tp:G1', true));
    expect(getMessagingGroupByPlatform('tp-declared', 'tp:G1')!.unknown_sender_policy).toBe('public');

    // ...and DM context reads the dm declaration.
    await routeInbound(mention('tp-declared', 'tp:D1', false));
    expect(getMessagingGroupByPlatform('tp-declared', 'tp:D1')!.unknown_sender_policy).toBe('strict');

    // Undeclared channel: the behavior-faithful fallback reproduces the
    // historical hardcoded 'request_approval'.
    await routeInbound(mention('tp-undeclared', 'tp:U1', true));
    expect(getMessagingGroupByPlatform('tp-undeclared', 'tp:U1')!.unknown_sender_policy).toBe('request_approval');
  });
});

describe('routing metadata preservation', () => {
  beforeEach(async () => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Test Agent',
      folder: 'test-agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'chan-123',
      name: 'General',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
    // A live threaded adapter, matching real Discord routing — inbound
    // platform events always have their receiving adapter live, and the
    // per-wiring thread policy hard-ANDs the live capability.
    const { registerChannelAdapter, initChannelAdapters } = await import('./channels/channel-registry.js');
    registerChannelAdapter('discord', {
      factory: () => ({
        name: 'discord',
        channelType: 'discord',
        supportsThreads: true,
        async setup() {},
        async teardown() {},
        isConnected: () => true,
        async deliver() {
          return undefined;
        },
      }),
    });
    await initChannelAdapters(() => ({
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    }));
  });

  afterEach(async () => {
    const { teardownChannelAdapters } = await import('./channels/channel-registry.js');
    await teardownChannelAdapters();
  });

  it('routed message carries platformId, channelType, threadId on the messages_in row', async () => {
    const { routeInbound } = await import('./router.js');

    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: 'thread-42',
      message: { id: 'msg-r1', kind: 'chat', content: JSON.stringify({ sender: 'A', text: 'hi' }), timestamp: now() },
    });

    // Threaded adapter in a group chat forces a per-thread session.
    const session = findSession('mg-1', 'thread-42');
    const db = new Database(inboundDbPath('ag-1', session!.id));
    const row = db
      .prepare('SELECT platform_id, channel_type, thread_id FROM messages_in WHERE id LIKE ?')
      .get('msg-r1%') as {
      platform_id: string | null;
      channel_type: string | null;
      thread_id: string | null;
    };
    db.close();

    expect(row.platform_id).toBe('chan-123');
    expect(row.channel_type).toBe('discord');
    expect(row.thread_id).toBe('thread-42');
  });

  it('fan-out gives each agent its own routing, not leaked from sibling', async () => {
    const { routeInbound } = await import('./router.js');

    createAgentGroup({
      id: 'ag-2',
      name: 'Agent Two',
      folder: 'agent-two',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-2',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-2',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });

    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: 'thread-fanout',
      message: { id: 'msg-fo', kind: 'chat', content: JSON.stringify({ text: 'fan' }), timestamp: now() },
    });

    // Both agents should have the message with correct routing
    const { getSessionsByAgentGroup } = await import('./db/sessions.js');
    for (const agId of ['ag-1', 'ag-2']) {
      const sessions = getSessionsByAgentGroup(agId);
      expect(sessions).toHaveLength(1);
      const db = new Database(inboundDbPath(agId, sessions[0].id));
      const row = db.prepare('SELECT platform_id, channel_type, thread_id FROM messages_in LIMIT 1').get() as {
        platform_id: string | null;
        channel_type: string | null;
        thread_id: string | null;
      };
      db.close();
      expect(row.platform_id).toBe('chan-123');
      expect(row.channel_type).toBe('discord');
      expect(row.thread_id).toBe('thread-fanout');
    }
  });
});

describe('writeSessionRouting', () => {
  it('populates session_routing from the messaging group', () => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Agent',
      folder: 'agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'telegram',
      platform_id: 'tg:12345',
      name: 'Chat',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });

    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    writeSessionRouting('ag-1', session.id);

    const db = new Database(inboundDbPath('ag-1', session.id));
    const row = db.prepare('SELECT channel_type, platform_id, thread_id FROM session_routing WHERE id = 1').get() as
      | {
          channel_type: string | null;
          platform_id: string | null;
          thread_id: string | null;
        }
      | undefined;
    db.close();

    expect(row).toBeDefined();
    expect(row!.channel_type).toBe('telegram');
    expect(row!.platform_id).toBe('tg:12345');
    expect(row!.thread_id).toBeNull();
  });

  it('writes null routing for agent-shared session (no messaging group)', () => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Agent',
      folder: 'agent',
      agent_provider: null,
      created_at: now(),
    });

    const { session } = resolveSession('ag-1', null, null, 'agent-shared');
    writeSessionRouting('ag-1', session.id);

    const db = new Database(inboundDbPath('ag-1', session.id));
    const row = db.prepare('SELECT channel_type, platform_id, thread_id FROM session_routing WHERE id = 1').get() as
      | {
          channel_type: string | null;
          platform_id: string | null;
          thread_id: string | null;
        }
      | undefined;
    db.close();

    expect(row).toBeDefined();
    expect(row!.channel_type).toBeNull();
    expect(row!.platform_id).toBeNull();
    expect(row!.thread_id).toBeNull();
  });

  it('includes thread_id from per-thread session', () => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Agent',
      folder: 'agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'chan-123',
      name: 'General',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });

    const { session } = resolveSession('ag-1', 'mg-1', 'thread-77', 'per-thread');
    writeSessionRouting('ag-1', session.id);

    const db = new Database(inboundDbPath('ag-1', session.id));
    const row = db.prepare('SELECT channel_type, platform_id, thread_id FROM session_routing WHERE id = 1').get() as
      | {
          channel_type: string | null;
          platform_id: string | null;
          thread_id: string | null;
        }
      | undefined;
    db.close();

    expect(row).toBeDefined();
    expect(row!.channel_type).toBe('discord');
    expect(row!.platform_id).toBe('chan-123');
    expect(row!.thread_id).toBe('thread-77');
  });
});

describe('agent-shared session resolution', () => {
  it('resolves to the same session on repeated calls', () => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Agent',
      folder: 'agent',
      agent_provider: null,
      created_at: now(),
    });

    const { session: s1, created: c1 } = resolveSession('ag-1', null, null, 'agent-shared');
    const { session: s2, created: c2 } = resolveSession('ag-1', null, null, 'agent-shared');

    expect(c1).toBe(true);
    expect(c2).toBe(false);
    expect(s1.id).toBe(s2.id);
  });

  it('agent-shared session has null messaging_group_id', () => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Agent',
      folder: 'agent',
      agent_provider: null,
      created_at: now(),
    });

    const { session } = resolveSession('ag-1', null, null, 'agent-shared');
    expect(session.messaging_group_id).toBeNull();
  });
});

describe('agent-to-agent routing', () => {
  beforeEach(() => {
    createAgentGroup({
      id: 'ag-pa',
      name: 'PA',
      folder: 'pa-agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-slack',
      channel_type: 'slack',
      platform_id: 'C-GENERAL',
      name: 'Slack General',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createAgentGroup({
      id: 'ag-researcher',
      name: 'Researcher',
      folder: 'researcher-agent',
      agent_provider: null,
      created_at: now(),
    });

    // Wire bidirectional A2A destinations (table created by runMigrations)
    const db = getDb();
    db.prepare(
      `INSERT OR IGNORE INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES ('ag-pa', 'researcher', 'agent', 'ag-researcher', ?)`,
    ).run(now());
    db.prepare(
      `INSERT OR IGNORE INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES ('ag-researcher', 'pa', 'agent', 'ag-pa', ?)`,
    ).run(now());
  });

  it('A2A outbound lands in a session for the target agent', async () => {
    const { routeAgentMessage } = await import('./modules/agent-to-agent/agent-route.js');

    const { session: paSlackSession } = resolveSession('ag-pa', 'mg-slack', null, 'shared');

    await routeAgentMessage(
      {
        id: 'out-a2a-1',
        platform_id: 'ag-researcher',
        content: JSON.stringify({ text: 'research this' }),
        in_reply_to: null,
      },
      paSlackSession,
    );

    const { getSessionsByAgentGroup } = await import('./db/sessions.js');
    const researcherSessions = getSessionsByAgentGroup('ag-researcher');
    expect(researcherSessions.length).toBeGreaterThanOrEqual(1);

    const rDb = new Database(inboundDbPath('ag-researcher', researcherSessions[0].id));
    const rows = rDb.prepare('SELECT platform_id, channel_type, content FROM messages_in').all() as Array<{
      platform_id: string | null;
      channel_type: string | null;
      content: string;
    }>;
    rDb.close();

    expect(rows).toHaveLength(1);
    expect(rows[0].channel_type).toBe('agent');
    expect(rows[0].platform_id).toBe('ag-pa');
    expect(JSON.parse(rows[0].content).text).toBe('research this');
  });

  it('A2A return path routes to originating session, not newest (#2332)', async () => {
    // PA has Slack session, then gets wired to Discord (newer session).
    // Researcher responds to PA. With the return-path fix, the reply
    // routes back to the Slack session (originator) not Discord (newest).
    const { routeAgentMessage } = await import('./modules/agent-to-agent/agent-route.js');

    const { session: paSlackSession } = resolveSession('ag-pa', 'mg-slack', null, 'shared');

    createMessagingGroup({
      id: 'mg-discord',
      channel_type: 'discord',
      platform_id: 'chan-discord',
      name: 'Discord',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    const { session: paDiscordSession } = resolveSession('ag-pa', 'mg-discord', null, 'shared');

    // PA sends from Slack
    await routeAgentMessage(
      { id: 'out-fwd', platform_id: 'ag-researcher', content: JSON.stringify({ text: 'research' }), in_reply_to: null },
      paSlackSession,
    );

    // Researcher responds back to PA
    const { getSessionsByAgentGroup } = await import('./db/sessions.js');
    const researcherSession = getSessionsByAgentGroup('ag-researcher')[0];

    await routeAgentMessage(
      { id: 'out-reply', platform_id: 'ag-pa', content: JSON.stringify({ text: 'found it' }), in_reply_to: null },
      researcherSession,
    );

    const slackDb = new Database(inboundDbPath('ag-pa', paSlackSession.id));
    const slackA2a = slackDb.prepare("SELECT * FROM messages_in WHERE channel_type = 'agent'").all();
    slackDb.close();

    const discordDb = new Database(inboundDbPath('ag-pa', paDiscordSession.id));
    const discordA2a = discordDb.prepare("SELECT * FROM messages_in WHERE channel_type = 'agent'").all();
    discordDb.close();

    // Fixed: response lands in Slack (origin) not Discord (newest)
    expect(slackA2a).toHaveLength(1);
    expect(discordA2a).toHaveLength(0);
  });

  it('BUG: A2A-only session gets null session_routing (#2332)', async () => {
    // Researcher only has an agent-shared session (no channel wiring).
    // writeSessionRouting writes nulls because messaging_group_id is null.
    const { routeAgentMessage } = await import('./modules/agent-to-agent/agent-route.js');

    const { session: paSession } = resolveSession('ag-pa', 'mg-slack', null, 'shared');
    await routeAgentMessage(
      { id: 'out-1', platform_id: 'ag-researcher', content: JSON.stringify({ text: 'go' }), in_reply_to: null },
      paSession,
    );

    const { getSessionsByAgentGroup } = await import('./db/sessions.js');
    const researcherSessions = getSessionsByAgentGroup('ag-researcher');
    expect(researcherSessions).toHaveLength(1);

    writeSessionRouting('ag-researcher', researcherSessions[0].id);

    const rDb = new Database(inboundDbPath('ag-researcher', researcherSessions[0].id));
    const routing = rDb.prepare('SELECT channel_type, platform_id FROM session_routing WHERE id = 1').get() as
      | {
          channel_type: string | null;
          platform_id: string | null;
        }
      | undefined;
    rDb.close();

    // BUG: session_routing is all null — researcher has no default routing
    expect(routing).toBeDefined();
    expect(routing!.channel_type).toBeNull();
    expect(routing!.platform_id).toBeNull();
  });
});

describe('delivery', () => {
  it('should detect undelivered messages in outbound DB', () => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Agent',
      folder: 'agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-test',
      channel_type: 'discord',
      platform_id: 'chan-test',
      name: 'Test',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });

    const { session } = resolveSession('ag-1', 'mg-test', null, 'shared');

    // Write a response to the outbound DB (simulating what the agent-runner does)
    const dbPath = outboundDbPath('ag-1', session.id);
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
       VALUES ('out-1', datetime('now'), 'chat', 'chan-123', 'discord', ?)`,
    ).run(JSON.stringify({ text: 'Agent response' }));

    const undelivered = db.prepare('SELECT * FROM messages_out').all() as Array<{
      id: string;
      content: string;
    }>;
    db.close();

    expect(undelivered).toHaveLength(1);
    expect(JSON.parse(undelivered[0].content).text).toBe('Agent response');
  });
});
