/**
 * Durable host-instance lease + single-active-host leadership.
 *
 * The host registers itself in `host_instances` at startup and renews its
 * lease on an interval, so restarts and overlapping instances become
 * observable durable facts instead of invisible process state. Session-claim
 * fencing reads the instance rows to refuse taking over a live host's
 * sessions.
 *
 * Leadership is the coarse gate on top: with the central DB on a network
 * backend, two host processes on different machines can point at the same
 * database, and the node-local ncl-socket guard cannot see across machines.
 * `awaitHostLeadership` guarantees exactly one active host per shared
 * central DB — a non-leader waits in standby and takes over when the
 * leader's lease lapses (boot then proceeds normally; adoption doubles as
 * the takeover resync). On a SQLite central DB the election short-circuits
 * to leader: same box by construction, byte-identical behavior for existing
 * installs. The per-session claim fencing stays the fine-grained safety net
 * underneath either way.
 */
import { randomUUID } from 'crypto';
import os from 'os';

import { INSTALL_SLUG } from './config.js';
import { getDb } from './db/connection.js';
import {
  markHostInstanceStopped,
  registerHostInstance,
  releaseHostLeadership,
  renewHostInstanceLease,
  renewHostLeadership,
  tryAcquireHostLeadership,
} from './db/coordination.js';
import { log } from './log.js';

const RENEW_INTERVAL_MS = 30_000;
// TTL is 3× the renewal interval: two consecutive renewals can fail (slow
// disk, transient DB contention) before the row reads as expired.
const LEASE_TTL_MS = 90_000;

let instanceId: string | null = null;
let renewTimer: NodeJS.Timeout | null = null;

/** The running host's instance id, or null before start / after stop. */
export function getHostInstanceId(): string | null {
  return instanceId;
}

export interface HostInstanceLeaseOptions {
  renewIntervalMs?: number;
  leaseTtlMs?: number;
}

export async function startHostInstanceLease(options: HostInstanceLeaseOptions = {}): Promise<string> {
  if (instanceId) throw new Error('host instance lease already started');
  const renewIntervalMs = options.renewIntervalMs ?? RENEW_INTERVAL_MS;
  const leaseTtlMs = options.leaseTtlMs ?? LEASE_TTL_MS;

  const id = randomUUID();
  await registerHostInstance({
    instanceId: id,
    installId: INSTALL_SLUG,
    hostname: os.hostname(),
    pid: process.pid,
    now: new Date().toISOString(),
    leaseExpiresAt: new Date(Date.now() + leaseTtlMs).toISOString(),
  });
  instanceId = id;

  renewTimer = setInterval(() => {
    void renewLease(id, leaseTtlMs);
  }, renewIntervalMs);
  // The renewal timer must never keep an otherwise-finished process alive.
  renewTimer.unref?.();
  return id;
}

async function renewLease(id: string, leaseTtlMs: number): Promise<void> {
  /* eslint-disable no-catch-all/no-catch-all -- lease writes are shadow state; a failed renewal must never affect the host */
  try {
    const renewed = await renewHostInstanceLease(id, new Date(Date.now() + leaseTtlMs).toISOString());
    if (!renewed) log.warn('Host instance lease row missing on renewal', { instanceId: id });
  } catch (err) {
    log.warn('Host instance lease renewal failed', { instanceId: id, err });
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

export async function stopHostInstanceLease(): Promise<void> {
  if (renewTimer) {
    clearInterval(renewTimer);
    renewTimer = null;
  }
  const id = instanceId;
  instanceId = null;
  if (!id) return;
  /* eslint-disable no-catch-all/no-catch-all -- graceful shutdown must proceed even if the stop stamp cannot be written */
  try {
    await markHostInstanceStopped(id, new Date().toISOString());
  } catch (err) {
    log.warn('Failed to mark host instance stopped', { instanceId: id, err });
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

// ── leadership ──

const LEADER_RETRY_INTERVAL_MS = 5_000;

type LeadershipState = 'none' | 'short-circuit' | 'elected';

let leadership: LeadershipState = 'none';
let leaderRenewTimer: NodeJS.Timeout | null = null;

/** True once this process is the active host (elected or short-circuited). */
export function isHostLeader(): boolean {
  return leadership !== 'none';
}

export interface HostLeadershipOptions {
  /** Standby poll cadence while another host holds leadership. */
  retryIntervalMs?: number;
  /** Leadership renewal cadence — same philosophy as the instance lease. */
  renewIntervalMs?: number;
  leaseTtlMs?: number;
  /**
   * 'auto' short-circuits on a SQLite central DB (same box by construction —
   * the ncl-socket guard is the same-box protection, and behavior stays
   * byte-identical for existing installs). 'always' runs the election
   * regardless of dialect; tests use it to exercise the machinery.
   */
  electionMode?: 'auto' | 'always';
  /**
   * Called when leadership is lost at runtime (renewal finds another leader —
   * impossible unless our lease lapsed under us). A half-leader is worse than
   * a restart, so the default exits nonzero and the supervisor restarts us
   * into standby.
   */
  onLeadershipLost?: (code: number) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve only as the active host. Requires the instance lease to be started
 * (the leadership claim is held under the instance id).
 */
export async function awaitHostLeadership(options: HostLeadershipOptions = {}): Promise<void> {
  const id = instanceId;
  if (!id) throw new Error('host leadership requires the instance lease to be started first');
  if (leadership !== 'none') throw new Error('host leadership already established');

  const mode = options.electionMode ?? 'auto';
  if (mode === 'auto' && getDb().dialect === 'sqlite') {
    leadership = 'short-circuit';
    return;
  }

  const retryIntervalMs = options.retryIntervalMs ?? LEADER_RETRY_INTERVAL_MS;
  const renewIntervalMs = options.renewIntervalMs ?? RENEW_INTERVAL_MS;
  const leaseTtlMs = options.leaseTtlMs ?? LEASE_TTL_MS;
  const onLost = options.onLeadershipLost ?? ((code: number) => process.exit(code));

  let announcedStandby = false;
  for (;;) {
    const acquired = await tryAcquireHostLeadership({
      installId: INSTALL_SLUG,
      instanceId: id,
      now: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + leaseTtlMs).toISOString(),
    });
    if (acquired) break;
    if (!announcedStandby) {
      log.info('standby: another host holds leadership for this install — waiting for its lease to lapse', {
        installId: INSTALL_SLUG,
        instanceId: id,
        retryIntervalMs,
      });
      announcedStandby = true;
    }
    await sleep(retryIntervalMs);
  }

  leadership = 'elected';
  if (announcedStandby) log.info('standby host took over leadership', { installId: INSTALL_SLUG, instanceId: id });
  else log.info('acquired active-host leadership', { installId: INSTALL_SLUG, instanceId: id });

  leaderRenewTimer = setInterval(() => {
    void renewLeadership(id, leaseTtlMs, onLost);
  }, renewIntervalMs);
  // Never keep an otherwise-finished process alive for a renewal tick.
  leaderRenewTimer.unref?.();
}

async function renewLeadership(id: string, leaseTtlMs: number, onLost: (code: number) => void): Promise<void> {
  /* eslint-disable no-catch-all/no-catch-all -- a transient renewal error must not kill the host; the lease TTL gives 3× headroom */
  try {
    const renewed = await renewHostLeadership(INSTALL_SLUG, id, new Date(Date.now() + leaseTtlMs).toISOString());
    if (renewed) return;
    // Row gone or taken. Re-acquire covers our own lapsed-but-unclaimed lease;
    // a live usurper means two hosts believed they were active — stop being one.
    const reacquired = await tryAcquireHostLeadership({
      installId: INSTALL_SLUG,
      instanceId: id,
      now: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + leaseTtlMs).toISOString(),
    });
    if (reacquired) {
      log.warn('Leadership lease had lapsed unclaimed — re-acquired', { installId: INSTALL_SLUG, instanceId: id });
      return;
    }
    log.error('Lost active-host leadership — another host has taken over; exiting so the supervisor restarts us into standby', {
      installId: INSTALL_SLUG,
      instanceId: id,
    });
    if (leaderRenewTimer) {
      clearInterval(leaderRenewTimer);
      leaderRenewTimer = null;
    }
    leadership = 'none';
    onLost(1);
  } catch (err) {
    log.warn('Leadership renewal failed', { installId: INSTALL_SLUG, instanceId: id, err });
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

/** Release leadership (prompt handoff): standby hosts acquire on their next retry. */
export async function stopHostLeadership(): Promise<void> {
  if (leaderRenewTimer) {
    clearInterval(leaderRenewTimer);
    leaderRenewTimer = null;
  }
  const state = leadership;
  leadership = 'none';
  if (state !== 'elected') return;
  const id = instanceId;
  if (!id) return;
  /* eslint-disable no-catch-all/no-catch-all -- graceful shutdown must proceed even if the release cannot be written; the lease lapses on its own */
  try {
    await releaseHostLeadership(INSTALL_SLUG, id);
  } catch (err) {
    log.warn('Failed to release host leadership', { installId: INSTALL_SLUG, instanceId: id, err });
  }
  /* eslint-enable no-catch-all/no-catch-all */
}
