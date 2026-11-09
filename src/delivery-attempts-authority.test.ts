/**
 * Delivery attempt counts are read from `delivery_attempts` rows, not process
 * memory — so a host restart no longer resets them. Rows written "by a
 * previous process life" (seeded directly) must count toward the give-up
 * decision of the current one.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
    DATA_DIR: '/tmp/nanoclaw-test-delivery-authority',
    GROUPS_DIR: '/tmp/nanoclaw-test-delivery-authority/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-delivery-authority';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from './db/index.js';
import { getDeliveryAttempt, recordDeliveryAttempt } from './db/coordination.js';
import { inboundDbPath, outboundDbPath } from './mailbox/sqlite/paths.js';
import { resolveSession } from './session-manager.js';
import { deliverSessionMessages, setDeliveryAdapter } from './delivery.js';

function now(): string {
  return new Date().toISOString();
}

async function seedAgentAndChannel(): Promise<void> {
  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'telegram',
    platform_id: 'telegram:123',
    name: 'Test Chat',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
}

function insertOutbound(agentGroupId: string, sessionId: string, msgId: string): void {
  const db = new Database(outboundDbPath(agentGroupId, sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
     VALUES (?, datetime('now'), 'chat', 'telegram:123', 'telegram', ?)`,
  ).run(msgId, JSON.stringify({ text: 'hello' }));
  db.close();
}

/** Attempts recorded by "a previous process life" — rows only, no module state. */
async function seedPriorAttempts(messageId: string, sessionId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await recordDeliveryAttempt({
      messageId,
      sessionId,
      now: now(),
      nextAttemptAt: null,
      error: 'failure from before the restart',
    });
  }
}

function deliveredRow(agentGroupId: string, sessionId: string, msgId: string): { status: string } | undefined {
  const db = new Database(inboundDbPath(agentGroupId, sessionId), { readonly: true });
  const row = db.prepare('SELECT status FROM delivered WHERE message_out_id = ?').get(msgId) as
    | { status: string }
    | undefined;
  db.close();
  return row;
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('delivery attempts survive a restart', () => {
  it('two attempts from a previous life plus one live failure is permanent give-up', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-poison');
    await seedPriorAttempts('out-poison', session.id, 2);

    let callCount = 0;
    setDeliveryAdapter({
      async deliver() {
        callCount++;
        throw new Error('still failing after the restart');
      },
    });

    // One live failure — attempt 3 of 3 overall. The old in-memory counter
    // would have called this attempt 1 and retried the poison message
    // through every future crash loop.
    await deliverSessionMessages(session);
    expect(callCount).toBe(1);
    expect(deliveredRow('ag-1', session.id, 'out-poison')?.status).toBe('failed');
    expect(await getDeliveryAttempt('out-poison')).toBeUndefined();

    // And it stays failed — the adapter is never consulted again.
    await deliverSessionMessages(session);
    expect(callCount).toBe(1);
  });

  it('a success after the restart clears the persisted count', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-recovers');
    await seedPriorAttempts('out-recovers', session.id, 2);

    setDeliveryAdapter({
      async deliver() {
        return 'plat-msg-ok';
      },
    });

    await deliverSessionMessages(session);
    expect(deliveredRow('ag-1', session.id, 'out-recovers')?.status).toBe('delivered');
    expect(await getDeliveryAttempt('out-recovers')).toBeUndefined();
  });
});
