import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { INSTALL_SLUG } from '../../config.js';
import { initSqliteTestDb, closeDb, runMigrations } from '../../db/index.js';
import { getHostInstanceId, startHostInstanceLease, stopHostInstanceLease } from '../../host-instance.js';
import {
  _leadershipRenewTick,
  awaitHostLeadership,
  getHostLeadership,
  getLeadershipDiagnostics,
  isHostLeader,
  startActiveHostGate,
  stopHostLeadership,
  tryAcquireHostLeadership,
} from './index.js';

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

describe('single-active-host leadership (module overlay)', () => {
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

  it('the boot gate starts the lease itself when the base tree has not', async () => {
    expect(getHostInstanceId()).toBeNull();
    await startActiveHostGate();
    expect(getHostInstanceId()).not.toBeNull();
    expect(isHostLeader()).toBe(true);
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
      role: 'all',
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
        role: 'all',
        instanceId: 'i-standby',
        now: iso(),
        leaseExpiresAt: iso(60_000),
      }),
    ).toBe(true);
  });

  it('steps down before a standby could take over when renewals cannot be confirmed', async () => {
    await startHostInstanceLease();
    const lost: number[] = [];
    let lostAtMs: number | null = null;
    const started = performance.now();
    // TTL 600ms, margin 250ms → the fence fires ~350ms after the acquire; a
    // standby's earliest legitimate takeover is the lease lapse at 600ms.
    await awaitHostLeadership({
      electionMode: 'always',
      renewIntervalMs: 50,
      leaseTtlMs: 600,
      stepDownMarginMs: 250,
      onLeadershipLost: (code) => {
        lost.push(code);
        lostAtMs = performance.now() - started;
      },
    });

    // The database goes away: every renewal now throws, no write can confirm.
    const { getDb } = await import('../../db/connection.js');
    await getDb().exec('DROP TABLE host_leadership');

    await sleep(450);
    expect(lost).toEqual([1]);
    expect(isHostLeader()).toBe(false);
    // Fired at/after the deadline, and STRICTLY before the lease lapse —
    // self-eviction precedes the earliest moment a standby could acquire.
    expect(lostAtMs!).toBeGreaterThanOrEqual(340);
    expect(lostAtMs!).toBeLessThan(600);
  });

  it('a slow renewal is never overlapped — the next tick skips, not queues', async () => {
    await startHostInstanceLease();
    await awaitHostLeadership({ electionMode: 'always', renewIntervalMs: 60_000, leaseTtlMs: 60_000 });
    const id = getHostInstanceId()!;
    const noLost = (): void => {};

    // Drive two ticks without awaiting the first: both enter before the
    // first's database write resolves, so the second must see the in-flight
    // flag and skip.
    const first = _leadershipRenewTick(id, 'all', 60_000, 15_000, noLost);
    const second = _leadershipRenewTick(id, 'all', 60_000, 15_000, noLost);
    await Promise.all([first, second]);

    const diagnostics = getLeadershipDiagnostics();
    expect(diagnostics.skippedRenewTicks).toBe(1);
    expect(diagnostics.renewInFlight).toBe(false);
    expect(diagnostics.state).toBe('elected');
  });

  it('rejects a step-down margin that could not fence anything', async () => {
    await startHostInstanceLease();
    await expect(
      awaitHostLeadership({ electionMode: 'always', leaseTtlMs: 400, stepDownMarginMs: 400 }),
    ).rejects.toThrow(/stepDownMarginMs/);
    await expect(
      awaitHostLeadership({ electionMode: 'always', leaseTtlMs: 400, stepDownMarginMs: 0 }),
    ).rejects.toThrow(/stepDownMarginMs/);
  });

  it('leadership seats are per (install, role) — two planes elect independently', async () => {
    // A live gateway leader does not block a controller claimant, and vice
    // versa: the process-split overlay runs one election per plane.
    expect(
      await tryAcquireHostLeadership({
        installId: INSTALL_SLUG,
        role: 'gateway',
        instanceId: 'i-gateway',
        now: iso(),
        leaseExpiresAt: iso(60_000),
      }),
    ).toBe(true);
    expect(
      await tryAcquireHostLeadership({
        installId: INSTALL_SLUG,
        role: 'controller',
        instanceId: 'i-controller',
        now: iso(),
        leaseExpiresAt: iso(60_000),
      }),
    ).toBe(true);
    // A second claimant for a held seat still loses.
    expect(
      await tryAcquireHostLeadership({
        installId: INSTALL_SLUG,
        role: 'gateway',
        instanceId: 'i-gateway-2',
        now: iso(),
        leaseExpiresAt: iso(60_000),
      }),
    ).toBe(false);
    expect((await getHostLeadership(INSTALL_SLUG, 'gateway'))?.leader_instance_id).toBe('i-gateway');
    expect((await getHostLeadership(INSTALL_SLUG, 'controller'))?.leader_instance_id).toBe('i-controller');
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
    const { getDb } = await import('../../db/connection.js');
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
