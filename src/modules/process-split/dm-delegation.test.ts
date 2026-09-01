import { describe, it, expect, afterEach, vi } from 'vitest';

import type { MessagingGroup } from '../../types.js';

// The gateway consumer resolves through the trunk's own ensureUserDm; the
// tests stand it in so the consumer's claim/resolve/delete choreography is
// proved without a live channel adapter.
const ensureUserDmMock = vi.fn();
vi.mock('../permissions/user-dm.js', () => ({
  ensureUserDm: (userId: string) => ensureUserDmMock(userId),
}));

type Round = {
  roleModule: typeof import('./role.js');
  delegation: typeof import('./dm-delegation.js');
  db: typeof import('../../db/index.js');
  messagingGroups: typeof import('../../db/messaging-groups.js');
  userDms: typeof import('../permissions/db/user-dms.js');
};

let lastRound: Round | null = null;

/** Same world-per-round harness as process-split.test.ts: reset every module,
 *  re-import under the role, own the whole DB lifecycle. */
async function withRole(role: string | undefined): Promise<Round> {
  vi.resetModules();
  vi.stubEnv('NANOCLAW_ROLE', role ?? '');
  const roleModule = await import('./role.js');
  const delegation = await import('./dm-delegation.js');
  const db = await import('../../db/index.js');
  const messagingGroups = await import('../../db/messaging-groups.js');
  const userDms = await import('../permissions/db/user-dms.js');
  const driver = await db.initSqliteTestDb();
  await db.runMigrations(driver);
  lastRound = { roleModule, delegation, db, messagingGroups, userDms };
  return lastRound;
}

afterEach(async () => {
  ensureUserDmMock.mockReset();
  vi.unstubAllEnvs();
  if (lastRound) {
    lastRound.delegation.stopDmResolutionConsumer();
    await lastRound.db.closeDb().catch(() => undefined);
    lastRound = null;
  }
});

const USER = 'slack:U1';

async function persistGatewayAnswer(round: Round, messagingGroupId: string): Promise<void> {
  const now = new Date().toISOString();
  // user_dms carries FKs to users and messaging_groups — satisfy both, the
  // way a real provision (user row) + resolution (mg row) would have.
  await round.db
    .getDb()
    .run(
      'INSERT INTO users (id, kind, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING',
      USER,
      'slack',
      now,
    );
  const mg: MessagingGroup = {
    id: messagingGroupId,
    channel_type: 'slack',
    platform_id: 'D1',
    name: null,
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now,
  } as MessagingGroup;
  await round.messagingGroups.createMessagingGroup(mg);
  await round.userDms.upsertUserDm({
    user_id: USER,
    channel_type: 'slack',
    messaging_group_id: messagingGroupId,
    resolved_at: now,
  });
}

describe('controller side — delegateUserDmResolution', () => {
  it('records the durable request and adopts the cache row the gateway persists', async () => {
    const round = await withRole('controller');
    const wait = round.delegation.delegateUserDmResolution(USER, 'slack', { totalMs: 5_000, pollMs: 25 });
    // The request row is durable before any answer exists.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const rows = await round.db
      .getDb()
      .all<{ user_id: string; channel_type: string }>('SELECT user_id, channel_type FROM user_dm_resolution_requests');
    expect(rows).toEqual([{ user_id: USER, channel_type: 'slack' }]);
    // The gateway answers by persisting exactly what ensureUserDm persists.
    await persistGatewayAnswer(round, 'mg-answer');
    const resolved = await wait;
    expect(resolved?.id).toBe('mg-answer');
  });

  it('reports the trunk contract null when no gateway ever answers', async () => {
    const round = await withRole('controller');
    const resolved = await round.delegation.delegateUserDmResolution(USER, 'slack', { totalMs: 120, pollMs: 25 });
    expect(resolved).toBeNull();
  });

  it('a re-request resets a stale claim instead of queueing a second row', async () => {
    const round = await withRole('controller');
    await round.delegation.delegateUserDmResolution(USER, 'slack', { totalMs: 1, pollMs: 1 });
    await round.db
      .getDb()
      .run('UPDATE user_dm_resolution_requests SET claimed_by = ?, claimed_at = ?', 'dead-gateway', '2020-01-01T00:00:00.000Z');
    await round.delegation.delegateUserDmResolution(USER, 'slack', { totalMs: 1, pollMs: 1 });
    const rows = await round.db
      .getDb()
      .all<{ user_id: string; claimed_at: string | null }>('SELECT user_id, claimed_at FROM user_dm_resolution_requests');
    expect(rows).toEqual([{ user_id: USER, claimed_at: null }]);
  });
});

describe('gateway side — consumeDmResolutionsOnce', () => {
  it('claims the request, resolves through the trunk resolver, and deletes the row', async () => {
    const round = await withRole('gateway');
    await round.db
      .getDb()
      .run(
        'INSERT INTO user_dm_resolution_requests (user_id, channel_type, requested_at) VALUES (?, ?, ?)',
        USER,
        'slack',
        new Date().toISOString(),
      );
    ensureUserDmMock.mockImplementation(async (userId: string) => {
      expect(userId).toBe(USER);
      await persistGatewayAnswer(round, 'mg-resolved');
      return round.messagingGroups.getMessagingGroup('mg-resolved');
    });
    await round.delegation.consumeDmResolutionsOnce();
    expect(ensureUserDmMock).toHaveBeenCalledTimes(1);
    const remaining = await round.db.getDb().all('SELECT user_id FROM user_dm_resolution_requests');
    expect(remaining).toEqual([]);
    // …and the answer is exactly the row a delegating controller adopts.
    const cached = await round.userDms.getUserDm(USER, 'slack');
    expect(cached?.messaging_group_id).toBe('mg-resolved');
  });

  it('deletes the row after a failed resolution — the controller times out to the trunk null', async () => {
    const round = await withRole('gateway');
    await round.db
      .getDb()
      .run(
        'INSERT INTO user_dm_resolution_requests (user_id, channel_type, requested_at) VALUES (?, ?, ?)',
        USER,
        'slack',
        new Date().toISOString(),
      );
    ensureUserDmMock.mockResolvedValue(null);
    await round.delegation.consumeDmResolutionsOnce();
    const remaining = await round.db.getDb().all('SELECT user_id FROM user_dm_resolution_requests');
    expect(remaining).toEqual([]);
  });

  it('a fresh claim is not stolen; a stale one is', async () => {
    const round = await withRole('gateway');
    const now = new Date().toISOString();
    await round.db
      .getDb()
      .run(
        'INSERT INTO user_dm_resolution_requests (user_id, channel_type, requested_at, claimed_by, claimed_at) VALUES (?, ?, ?, ?, ?)',
        USER,
        'slack',
        now,
        'other-gateway',
        now,
      );
    await round.delegation.consumeDmResolutionsOnce();
    expect(ensureUserDmMock).not.toHaveBeenCalled();

    await round.db
      .getDb()
      .run('UPDATE user_dm_resolution_requests SET claimed_at = ?', '2020-01-01T00:00:00.000Z');
    ensureUserDmMock.mockResolvedValue(null);
    await round.delegation.consumeDmResolutionsOnce();
    expect(ensureUserDmMock).toHaveBeenCalledTimes(1);
  });

  it('double-starting the consumer is a boot bug, not a silent second timer', async () => {
    const round = await withRole('gateway');
    round.delegation.startDmResolutionConsumer(60_000);
    expect(() => round.delegation.startDmResolutionConsumer(60_000)).toThrow(/already started/);
  });
});
