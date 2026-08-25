import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { INSTALL_SLUG } from './config.js';
import { initSqliteTestDb, closeDb, runMigrations } from './db/index.js';
import { getHostLeadership, tryAcquireHostLeadership } from './db/coordination.js';
import {
  awaitHostLeadership,
  getHostInstanceId,
  isHostLeader,
  startHostInstanceLease,
  stopHostInstanceLease,
  stopHostLeadership,
} from './host-instance.js';

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(async () => {
  const db = await initSqliteTestDb();
  await runMigrations(db);
});

afterEach(async () => {
  await stopHostLeadership();
  await stopHostInstanceLease();
  await closeDb();
});

describe('host leadership', () => {
  it('short-circuits on a sqlite central DB — leader immediately, no election rows', async () => {
    await startHostInstanceLease();
    expect(isHostLeader()).toBe(false);
    await awaitHostLeadership();
    expect(isHostLeader()).toBe(true);
    expect(await getHostLeadership(INSTALL_SLUG)).toBeUndefined();
  });

  it('requires the instance lease first', async () => {
    await expect(awaitHostLeadership()).rejects.toThrow(/instance lease/);
  });

  it('acquires, renews on the interval, and releases the row on stop', async () => {
    await startHostInstanceLease();
    await awaitHostLeadership({ electionMode: 'always', renewIntervalMs: 25, leaseTtlMs: 500 });
    expect(isHostLeader()).toBe(true);

    const initial = await getHostLeadership(INSTALL_SLUG);
    expect(initial?.leader_instance_id).toBe(getHostInstanceId());

    await sleep(80);
    const renewed = await getHostLeadership(INSTALL_SLUG);
    expect(renewed?.lease_expires_at ?? '').not.toBe('');
    expect(renewed!.lease_expires_at > initial!.lease_expires_at).toBe(true);

    await stopHostLeadership();
    expect(isHostLeader()).toBe(false);
    expect(await getHostLeadership(INSTALL_SLUG)).toBeUndefined();
  });

  it('waits in standby behind a live leader and takes over when its lease lapses', async () => {
    // Another host holds leadership with a lease about to lapse.
    await tryAcquireHostLeadership({
      installId: INSTALL_SLUG,
      instanceId: 'i-other',
      now: iso(),
      leaseExpiresAt: iso(120),
    });
    await startHostInstanceLease();

    const started = Date.now();
    await awaitHostLeadership({ electionMode: 'always', retryIntervalMs: 20, renewIntervalMs: 60_000 });
    // Could not have won before the incumbent's lease lapsed.
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect((await getHostLeadership(INSTALL_SLUG))?.leader_instance_id).toBe(getHostInstanceId());
  });

  it('a graceful release hands leadership to the next claimant immediately', async () => {
    await startHostInstanceLease();
    await awaitHostLeadership({ electionMode: 'always', renewIntervalMs: 60_000 });
    await stopHostLeadership();
    // A standby's very next retry succeeds — no lease lapse to wait for.
    expect(
      await tryAcquireHostLeadership({
        installId: INSTALL_SLUG,
        instanceId: 'i-standby',
        now: iso(),
        leaseExpiresAt: iso(60_000),
      }),
    ).toBe(true);
  });

  it('losing leadership at runtime calls the lost hook instead of limping on', async () => {
    await startHostInstanceLease();
    const lost: number[] = [];
    await awaitHostLeadership({
      electionMode: 'always',
      renewIntervalMs: 20,
      leaseTtlMs: 500,
      onLeadershipLost: (code) => lost.push(code),
    });

    // Simulate a usurper: overwrite the row with a live foreign lease. The
    // CAS accessor refuses live incumbents, so force it at the SQL level —
    // this models the "our lease lapsed under us and another host won" state.
    const { getDb } = await import('./db/connection.js');
    await getDb().run(
      'UPDATE host_leadership SET leader_instance_id = ?, lease_expires_at = ? WHERE install_id = ?',
      'i-usurper',
      iso(60_000),
      INSTALL_SLUG,
    );

    await sleep(100);
    expect(lost).toEqual([1]);
    expect(isHostLeader()).toBe(false);
    // The usurper's row is untouched — we backed off, not fought.
    expect((await getHostLeadership(INSTALL_SLUG))?.leader_instance_id).toBe('i-usurper');
  });
});
