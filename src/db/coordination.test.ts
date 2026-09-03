import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initSqliteTestDb, closeDb, runMigrations } from './index.js';
import {
  registerHostInstance,
  renewHostInstanceLease,
  markHostInstanceStopped,
  listLiveHostInstances,
  getSessionClaim,
  tryClaimSession,
  releaseSessionClaim,
  setStopIntent,
  recordDeliveryAttempt,
  getDeliveryAttempt,
  clearDeliveryAttempt,
  writeWakeSignal,
  takeWakeSignals,
} from './coordination.js';

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

beforeEach(async () => {
  const db = await initSqliteTestDb();
  await runMigrations(db);
});

afterEach(async () => {
  await closeDb();
});

describe('host_instances', () => {
  it('registers, renews, and expires leases', async () => {
    await registerHostInstance({
      instanceId: 'i-1',
      installId: 'ab12cd34',
      now: iso(),
      leaseExpiresAt: iso(30_000),
    });
    expect(await listLiveHostInstances(iso())).toHaveLength(1);
    // Lease behind `now` → not live.
    expect(await listLiveHostInstances(iso(60_000))).toHaveLength(0);
    expect(await renewHostInstanceLease('i-1', iso(120_000))).toBe(true);
    expect(await listLiveHostInstances(iso(60_000))).toHaveLength(1);
    await markHostInstanceStopped('i-1', iso());
    expect(await listLiveHostInstances(iso())).toHaveLength(0);
    expect(await renewHostInstanceLease('i-1', iso(240_000))).toBe(false);
  });

  it('re-registering the same instance clears stopped_at', async () => {
    await registerHostInstance({ instanceId: 'i-1', installId: 'x', now: iso(), leaseExpiresAt: iso(30_000) });
    await markHostInstanceStopped('i-1', iso());
    await registerHostInstance({ instanceId: 'i-1', installId: 'x', now: iso(), leaseExpiresAt: iso(30_000) });
    expect(await listLiveHostInstances(iso())).toHaveLength(1);
  });
});

describe('session_claims', () => {
  it('first claim creates the row at incarnation 1', async () => {
    const inc = await tryClaimSession({ sessionId: 's-1', instanceId: 'i-1', expectedIncarnation: 0, now: iso() });
    expect(inc).toBe(1);
    const claim = await getSessionClaim('s-1');
    expect(claim?.incarnation).toBe(1);
    expect(claim?.claimed_by).toBe('i-1');
  });

  it('CAS on a stale incarnation loses', async () => {
    await tryClaimSession({ sessionId: 's-1', instanceId: 'i-1', expectedIncarnation: 0, now: iso() });
    // A second claimant that still believes incarnation 0 must lose.
    expect(
      await tryClaimSession({ sessionId: 's-1', instanceId: 'i-2', expectedIncarnation: 0, now: iso() }),
    ).toBeNull();
    // A claimant with the current view wins and fences the previous one.
    expect(await tryClaimSession({ sessionId: 's-1', instanceId: 'i-2', expectedIncarnation: 1, now: iso() })).toBe(2);
  });

  it('release is fenced by holder and incarnation', async () => {
    await tryClaimSession({ sessionId: 's-1', instanceId: 'i-1', expectedIncarnation: 0, now: iso() });
    expect(await releaseSessionClaim({ sessionId: 's-1', instanceId: 'i-2', incarnation: 1, now: iso() })).toBe(false);
    expect(await releaseSessionClaim({ sessionId: 's-1', instanceId: 'i-1', incarnation: 1, now: iso() })).toBe(true);
    expect((await getSessionClaim('s-1'))?.claimed_by).toBeNull();
  });

  it('stop intent persists on a row that has never been claimed', async () => {
    await setStopIntent('s-9', 'respawn_after_stop', iso());
    expect((await getSessionClaim('s-9'))?.stop_intent).toBe('respawn_after_stop');
    await setStopIntent('s-9', null, iso());
    expect((await getSessionClaim('s-9'))?.stop_intent).toBeNull();
  });
});

describe('delivery_attempts', () => {
  it('counts attempts and clears on success', async () => {
    expect(
      await recordDeliveryAttempt({ messageId: 'm-1', sessionId: 's-1', now: iso(), nextAttemptAt: iso(5_000) }),
    ).toBe(1);
    expect(
      await recordDeliveryAttempt({ messageId: 'm-1', sessionId: 's-1', now: iso(), nextAttemptAt: null, error: 'x' }),
    ).toBe(2);
    expect((await getDeliveryAttempt('m-1'))?.last_error).toBe('x');
    await clearDeliveryAttempt('m-1');
    expect(await getDeliveryAttempt('m-1')).toBeUndefined();
  });
});

describe('wake_signals', () => {
  it('each signal is consumed exactly once', async () => {
    await writeWakeSignal('s-1', 'inbound-message', iso());
    await writeWakeSignal('s-1', 'due-message', iso());
    await writeWakeSignal('s-2', 'inbound-message', iso());

    const taken = await takeWakeSignals({ consumerId: 'i-1', now: iso(), sessionId: 's-1' });
    // Same-ms created_at stamps make relative order unspecified — compare as a set.
    expect(taken.map((signal) => signal.reason).sort()).toEqual(['due-message', 'inbound-message']);

    // Already-consumed signals are not re-delivered; s-2 remains.
    const rest = await takeWakeSignals({ consumerId: 'i-2', now: iso() });
    expect(rest).toHaveLength(1);
    expect(rest[0].session_id).toBe('s-2');
    expect(await takeWakeSignals({ consumerId: 'i-3', now: iso() })).toHaveLength(0);
  });
});
