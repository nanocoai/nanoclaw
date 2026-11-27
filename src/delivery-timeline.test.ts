/**
 * Delivery records each top-level agent post in its conversation's timeline
 * (cross-session-context timeline.ts), the rows a new thread's backfill reads
 * instead of opening this session's mailbox. A reply inside a thread is not a
 * top-level post and is not recorded.
 *
 * Drives `deliverToSessions` against real session mailboxes on disk, as
 * delivery-poll.test.ts does.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-delivery-timeline',
    GROUPS_DIR: '/tmp/nanoclaw-test-delivery-timeline/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-delivery-timeline';

import { getDb } from './db/connection.js';
import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from './db/index.js';
import { deliverToSessions, setDeliveryAdapter, stopDeliveryPolls } from './delivery.js';
import { outboundDbPath } from './mailbox/sqlite/paths.js';
import { settleEchoFans } from './modules/cross-session-context/index.js';
import { resolveSession } from './session-manager.js';

function now(): string {
  return new Date().toISOString();
}

function insertOutbound(agentGroupId: string, sessionId: string, msgId: string, threadId: string | null, text: string) {
  const db = new Database(outboundDbPath(agentGroupId, sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, content)
     VALUES (?, ?, 'chat', 'slack:D1', 'slack', ?, ?)`,
  ).run(msgId, now(), threadId, JSON.stringify({ text }));
  db.close();
}

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  await createAgentGroup({ id: 'ag-1', name: 'Pete', folder: 'pete', agent_provider: null, created_at: now() });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'slack',
    platform_id: 'slack:D1',
    name: 'dm',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
});

afterEach(async () => {
  stopDeliveryPolls();
  await settleEchoFans();
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('delivery and the conversation timeline', () => {
  it('records a delivered top-level post, not a reply in a thread', async () => {
    const { session: top } = await resolveSession('ag-1', 'mg-1', null, 'per-thread');
    const { session: threaded } = await resolveSession('ag-1', 'mg-1', 'slack:D1:100.1', 'per-thread');
    insertOutbound('ag-1', top.id, 'out-top', null, 'Welcome! Want a tour?');
    insertOutbound('ag-1', threaded.id, 'out-thread', 'slack:D1:100.1', 'Here is the deck.');
    let n = 0;
    setDeliveryAdapter({ deliver: async () => `pm-${++n}` });

    await deliverToSessions([top, threaded]);
    await vi.waitFor(async () => {
      const rows = await getDb().all('SELECT 1 FROM conversation_timeline');
      expect(rows.length).toBeGreaterThan(0);
    });

    const rows = await getDb().all<{ session_id: string; text: string; sender: string; self: number }>(
      'SELECT session_id, text, sender, self FROM conversation_timeline',
    );
    expect(rows).toEqual([{ session_id: top.id, text: 'Welcome! Want a tour?', sender: 'Pete', self: 1 }]);
  });
});
