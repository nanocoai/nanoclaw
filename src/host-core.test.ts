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
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import {
  resolveSession,
  writeSessionMessage,
  initSessionFolder,
  sessionDir,
  inboundDbPath,
  outboundDbPath,
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

  it('routes an embed-only (empty-text) message with trigger=1 when engage_mode=pattern pat=dot (regression: axiom-wake-bug)', async () => {
    // Regression for AGE-16: Axiom webhook alerts are Discord messages whose
    // `content` field is empty — only `embeds` carry the alert body.
    // The Chat SDK's onNewMessage was registered with /./  which does NOT
    // match empty string, silently dropping these messages before they reached
    // routeInbound. The fix changed the pattern to /.*/ which does match "".
    // Here we test that routeInbound itself correctly assigns trigger=1 for
    // empty-text messages with a pattern='.' (match-all) wiring, so if the
    // bridge pattern were accidentally reverted, the router's own side would
    // still be auditable.
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: {
        id: 'msg-embed-only',
        kind: 'chat-sdk',
        // Empty text — simulates a Discord webhook embed-only message (e.g. Axiom alert)
        content: JSON.stringify({ text: '', author: { userId: 'axiom-webhook', isBot: true } }),
        timestamp: now(),
      },
    });

    expect(wakeContainer).toHaveBeenCalled();

    const session = findSession('mg-1', null);
    expect(session).toBeDefined();
    const db = new Database(inboundDbPath('ag-1', session!.id));
    const rows = db.prepare('SELECT trigger FROM messages_in').all() as Array<{ trigger: number }>;
    db.close();
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger).toBe(1);
  });

  it('per-thread wiring: top-level channel post (threadId = platformId) opens and wakes a session', async () => {
    // Regression for AGE-16 hypothesis 1: with session_mode=per-thread the
    // router must create (or find) a session for top-level Discord posts,
    // where threadId equals the channel platformId. If no session matches,
    // one is created and the container is woken with trigger=1.
    const { updateMessagingGroupAgent } = await import('./db/messaging-groups.js');
    updateMessagingGroupAgent('mga-1', { session_mode: 'per-thread' });

    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: 'chan-123', // top-level post: threadId === platformId (no Discord thread suffix)
      message: {
        id: 'msg-toplevel',
        kind: 'chat-sdk',
        content: JSON.stringify({ text: 'alert fired in channel' }),
        timestamp: now(),
      },
    });

    expect(wakeContainer).toHaveBeenCalled();

    const { getSessionsByAgentGroup } = await import('./db/sessions.js');
    const sessions = getSessionsByAgentGroup('ag-1');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].thread_id).toBe('chan-123');
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
