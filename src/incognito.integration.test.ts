/**
 * Integration tests for the /incognito routing flow through routeInbound.
 * Container spawning + delivery are mocked; assertions read the session DBs.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = vi.hoisted(() => '/tmp/nanoclaw-test-incognito-int');

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

vi.mock('./delivery.js', async () => {
  const actual = await vi.importActual<typeof import('./delivery.js')>('./delivery.js');
  return { ...actual, deliverSessionMessages: vi.fn().mockResolvedValue(undefined) };
});

import {
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initTestDb,
  runMigrations,
  closeDb,
} from './db/index.js';
import { findSessionForAgent, findTemporalSession, getSession } from './db/sessions.js';
import { outboundDbPath, inboundDbPath, sessionDir } from './session-manager.js';
import type { InboundEvent } from './channels/adapter.js';

function now() {
  return new Date().toISOString();
}

const ag = `ag-${randomUUID()}`;
const dm = `mg-dm-${randomUUID()}`;
const group = `mg-grp-${randomUUID()}`;

function messagesIn(sessionId: string): Array<{ id: string; content: string }> {
  const db = new Database(inboundDbPath(ag, sessionId), { readonly: true });
  try {
    return db.prepare('SELECT id, content FROM messages_in ORDER BY timestamp').all() as Array<{
      id: string;
      content: string;
    }>;
  } finally {
    db.close();
  }
}

function messagesOutText(sessionId: string): string[] {
  const db = new Database(outboundDbPath(ag, sessionId), { readonly: true });
  try {
    const rows = db.prepare('SELECT content FROM messages_out ORDER BY seq').all() as Array<{ content: string }>;
    return rows.map((r) => JSON.parse(r.content).text as string);
  } finally {
    db.close();
  }
}

function dmEvent(text: string, id = `msg-${randomUUID()}`): InboundEvent {
  return {
    channelType: 'discord',
    platformId: 'dm-chan',
    threadId: null,
    message: { id, kind: 'chat', content: JSON.stringify({ sender: 'User', text }), timestamp: now() },
  };
}

describe('/incognito routing (integration)', () => {
  beforeEach(() => {
    vi.clearAllMocks(); // reset call history (keeps mockResolvedValue impls) — mocks are module-shared across tests
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = initTestDb();
    runMigrations(db);

    createAgentGroup({
      id: ag,
      name: 'Agent',
      folder: `folder-${randomUUID()}`,
      agent_provider: null,
      created_at: now(),
    });

    // A DM (is_group=0) and a group chat (is_group=1), both wired to the agent.
    for (const [id, isGroup, platform] of [
      [dm, 0, 'dm-chan'],
      [group, 1, 'grp-chan'],
    ] as const) {
      createMessagingGroup({
        id,
        channel_type: 'discord',
        platform_id: platform,
        name: 'chat',
        is_group: isGroup,
        unknown_sender_policy: 'public',
        created_at: now(),
      });
      createMessagingGroupAgent({
        id: `mga-${randomUUID()}`,
        messaging_group_id: id,
        agent_group_id: ag,
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

  afterEach(() => {
    closeDb();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('/incognito <msg> starts a temporal session and leaves the normal session untouched', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');

    await routeInbound(dmEvent('/incognito what is 2+2'));

    const temporal = findTemporalSession(ag, dm, null);
    expect(temporal).toBeDefined();
    expect(temporal!.temporal).toBe(1);
    // No normal session created yet.
    expect(findSessionForAgent(ag, dm, null)).toBeUndefined();

    // The prefix-stripped first turn is delivered to the temporal session.
    const rows = messagesIn(temporal!.id);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content).text).toBe('what is 2+2');
    expect(wakeContainer).toHaveBeenCalled();
  });

  it('bare /incognito emits an "Incognito on" note without waking a container', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');

    await routeInbound(dmEvent('/incognito'));

    const temporal = findTemporalSession(ag, dm, null);
    expect(temporal).toBeDefined();
    expect(messagesOutText(temporal!.id).join('\n')).toContain('Incognito on');
    expect(wakeContainer).not.toHaveBeenCalled();
  });

  it('a follow-up message continues in the active temporal session', async () => {
    const { routeInbound } = await import('./router.js');
    await routeInbound(dmEvent('/incognito first'));
    const temporal = findTemporalSession(ag, dm, null)!;

    await routeInbound(dmEvent('second'));

    // Same temporal session, two turns; still no normal session.
    expect(findTemporalSession(ag, dm, null)!.id).toBe(temporal.id);
    expect(messagesIn(temporal.id)).toHaveLength(2);
    expect(findSessionForAgent(ag, dm, null)).toBeUndefined();
  });

  it('/incognito end tears down the temporal session and confirms via the normal session', async () => {
    const { routeInbound } = await import('./router.js');
    await routeInbound(dmEvent('/incognito hi'));
    const temporal = findTemporalSession(ag, dm, null)!;
    const tempDir = sessionDir(ag, temporal.id);
    expect(fs.existsSync(tempDir)).toBe(true);

    await routeInbound(dmEvent('/incognito end'));

    // Temporal session + folder gone.
    expect(findTemporalSession(ag, dm, null)).toBeUndefined();
    expect(getSession(temporal.id)).toBeUndefined();
    expect(fs.existsSync(tempDir)).toBe(false);

    // Confirmation delivered via the (now-existing) normal session.
    const normal = findSessionForAgent(ag, dm, null);
    expect(normal).toBeDefined();
    expect(messagesOutText(normal!.id).join('\n')).toContain('Incognito off');
  });

  it('/incognito in a group chat is refused and creates no temporal session', async () => {
    const { routeInbound } = await import('./router.js');

    await routeInbound({
      channelType: 'discord',
      platformId: 'grp-chan',
      threadId: null,
      message: {
        id: `msg-${randomUUID()}`,
        kind: 'chat',
        content: JSON.stringify({ sender: 'User', text: '/incognito secret' }),
        timestamp: now(),
      },
    });

    expect(findTemporalSession(ag, group, null)).toBeUndefined();
    const normal = findSessionForAgent(ag, group, null);
    expect(normal).toBeDefined();
    expect(messagesOutText(normal!.id).join('\n')).toContain('only available in direct messages');
  });
});
