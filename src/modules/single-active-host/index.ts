/**
 * Single-active-host election — exactly one active host per shared central DB.
 *
 * Recipes overlay module (single-active-host skill): multi-host coordination
 * is an enterprise deployment concern and stays out of the OSS trunk. With
 * the central DB on a network backend, two host processes on different
 * machines can point at the same database, and the node-local ncl-socket
 * guard cannot see across machines. This module is the coarse gate above the
 * per-session claim fencing: one CAS-acquired, lease-renewed leader row per
 * install. On a SQLite central DB the election short-circuits to leader
 * (same box by construction — the socket guard is the same-box protection),
 * so composed trees behave byte-identically until a network backend is
 * configured.
 *
 * The `host_leadership` table arrives as a module migration
 * (`module:single-active-host:host-leadership`), registered at import time —
 * the boot wiring imports this module before `runMigrations` runs.
 */
import { INSTALL_SLUG } from '../../config.js';
import { getDb } from '../../db/connection.js';
import { registerMigration } from '../../db/migrations/index.js';
import { getHostInstanceId, startHostInstanceLease } from '../../host-instance.js';
import { log } from '../../log.js';

registerMigration({
  // Module migrations order by registration, not version; the field is
  // informational (second schema revision: leadership is per (install, role)
  // so the process-split overlay can elect one leader per plane; a solo
  // install uses the single 'all' role and behaves exactly as before).
  version: 2,
  name: 'module:single-active-host:host-leadership',
  async up(db) {
    await db.exec(`
      CREATE TABLE host_leadership (
        install_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'all',
        leader_instance_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        PRIMARY KEY (install_id, role)
      );
    `);
  },
});

// Same cadence philosophy as the host-instance lease: renew at a third of the
// TTL so two consecutive renewals may fail before the row reads as lapsed.
const RENEW_INTERVAL_MS = 30_000;
const LEASE_TTL_MS = 90_000;
const LEADER_RETRY_INTERVAL_MS = 5_000;
/**
 * How long BEFORE its own lease could lapse the leader stops acting when it
 * cannot confirm renewals — the split-brain fence. The lease rows carry
 * wall-clock ISO stamps (caller clocks, the coordination-table rule), so a
 * standby's takeover moment is measured by ITS wall clock against OUR stamp;
 * the step-down deadline runs on this process's MONOTONIC clock from the last
 * confirmed write. The invariant `leader stops < standby starts` therefore
 * holds as long as combined wall-clock skew between the two hosts stays under
 * this margin minus stop-work latency. We deliberately do NOT move the lease
 * comparison onto the database server's clock: the election machinery is
 * exercised by tests on SQLite (electionMode 'always'), and dialect-forked
 * SQL would make tests prove different statements than production runs. A
 * 15s margin tolerates ~7s of skew per host — orders beyond NTP drift —
 * while still giving the 30s renewal cadence two full attempts (renewals at
 * 30s and 60s, step-down at 75s).
 */
const STEP_DOWN_MARGIN_MS = 15_000;

// ── host_leadership accessors (portable SQL, caller clocks, ISO compares) ──

export interface HostLeadershipRow {
  install_id: string;
  role: string;
  leader_instance_id: string;
  acquired_at: string;
  lease_expires_at: string;
}

/**
 * CAS-acquire the install's leader row. Succeeds when the row is absent, when
 * the incumbent's lease has lapsed as of `now`, or when the incumbent is the
 * caller (re-acquire after a missed renewal). A live incumbent wins. One
 * statement — the insert-or-conditional-update is atomic on every backend the
 * DbDriver speaks, so takeover can never interleave with a competing acquire.
 */
export async function tryAcquireHostLeadership(args: {
  installId: string;
  role: string;
  instanceId: string;
  now: string;
  leaseExpiresAt: string;
}): Promise<boolean> {
  const result = await getDb().run(
    `INSERT INTO host_leadership (install_id, role, leader_instance_id, acquired_at, lease_expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (install_id, role) DO UPDATE SET
       leader_instance_id = excluded.leader_instance_id,
       acquired_at = excluded.acquired_at,
       lease_expires_at = excluded.lease_expires_at
     WHERE host_leadership.lease_expires_at <= excluded.acquired_at
        OR host_leadership.leader_instance_id = excluded.leader_instance_id`,
    args.installId,
    args.role,
    args.instanceId,
    args.now,
    args.leaseExpiresAt,
  );
  return result.changes > 0;
}

/** Renew only while still the leader. False means leadership was lost. */
export async function renewHostLeadership(
  installId: string,
  role: string,
  instanceId: string,
  leaseExpiresAt: string,
): Promise<boolean> {
  const result = await getDb().run(
    'UPDATE host_leadership SET lease_expires_at = ? WHERE install_id = ? AND role = ? AND leader_instance_id = ?',
    leaseExpiresAt,
    installId,
    role,
    instanceId,
  );
  return result.changes > 0;
}

/** Release only if the caller still holds the row — a prompt handoff on graceful shutdown. */
export async function releaseHostLeadership(installId: string, role: string, instanceId: string): Promise<boolean> {
  const result = await getDb().run(
    'DELETE FROM host_leadership WHERE install_id = ? AND role = ? AND leader_instance_id = ?',
    installId,
    role,
    instanceId,
  );
  return result.changes > 0;
}

export async function getHostLeadership(installId: string, role = 'all'): Promise<HostLeadershipRow | undefined> {
  return getDb().get<HostLeadershipRow>(
    'SELECT * FROM host_leadership WHERE install_id = ? AND role = ?',
    installId,
    role,
  );
}

// ── the election ──

type LeadershipState = 'none' | 'short-circuit' | 'elected';

let leadership: LeadershipState = 'none';
let leadershipRole = 'all';
let leaderRenewTimer: NodeJS.Timeout | null = null;
let stepDownTimer: NodeJS.Timeout | null = null;
let renewInFlight = false;
let skippedRenewTicks = 0;
let lastConfirmedMono: number | null = null;

/** True once this process is the active host (elected or short-circuited). */
export function isHostLeader(): boolean {
  return leadership !== 'none';
}

/** Operational visibility into the lease loop (also what the tests read). */
export function getLeadershipDiagnostics(): {
  state: 'none' | 'short-circuit' | 'elected';
  renewInFlight: boolean;
  skippedRenewTicks: number;
  msSinceConfirmed: number | null;
} {
  return {
    state: leadership,
    renewInFlight,
    skippedRenewTicks,
    msSinceConfirmed: lastConfirmedMono === null ? null : performance.now() - lastConfirmedMono,
  };
}

/** Drop all leader state and timers — the one way out of 'elected'. */
function relinquishLeadership(): void {
  if (leaderRenewTimer) {
    clearInterval(leaderRenewTimer);
    leaderRenewTimer = null;
  }
  if (stepDownTimer) {
    clearTimeout(stepDownTimer);
    stepDownTimer = null;
  }
  leadership = 'none';
  lastConfirmedMono = null;
  renewInFlight = false;
}

/**
 * A write that proves the row still names us landed — re-arm the split-brain
 * fence. `issuedAtMono` is captured when the write was ISSUED, not when it
 * resolved: the lease stamp the database now holds was computed at issue
 * time, so the deadline must be measured from there (a slow round-trip eats
 * into the deadline, never extends it).
 */
function confirmLease(issuedAtMono: number, leaseTtlMs: number, stepDownMarginMs: number, onLost: (code: number) => void): void {
  if (leadership !== 'elected') return;
  lastConfirmedMono = issuedAtMono;
  if (stepDownTimer) clearTimeout(stepDownTimer);
  const dueInMs = issuedAtMono + leaseTtlMs - stepDownMarginMs - performance.now();
  stepDownTimer = setTimeout(() => {
    void stepDownExpired(onLost);
  }, Math.max(0, dueInMs));
  stepDownTimer.unref?.();
}

/**
 * The fence fired: no confirmed renewal within TTL − margin. Stop being the
 * leader BEFORE any standby's clock could read our lease as lapsed — acting
 * past this point is the two-leaders window the review named. Release is
 * best-effort (the database is probably the thing that's down); if it lands,
 * a standby takes over immediately instead of waiting out the lapse.
 */
async function stepDownExpired(onLost: (code: number) => void): Promise<void> {
  if (leadership !== 'elected') return;
  const role = leadershipRole;
  log.error(
    'No confirmed leadership renewal within the step-down deadline — stepping down before a standby can legitimately take over',
    { installId: INSTALL_SLUG, role, instanceId: getHostInstanceId() },
  );
  const id = getHostInstanceId();
  relinquishLeadership();
  if (id) {
    /* eslint-disable no-catch-all/no-catch-all -- release is best-effort: the DB is likely the thing that is down */
    try {
      await releaseHostLeadership(INSTALL_SLUG, role, id);
    } catch {
      // The lease lapses on its own; the standby waits it out.
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }
  onLost(1);
}

export interface HostLeadershipOptions {
  /**
   * The leadership seat to contend for. A solo host uses the single 'all'
   * seat; the process-split overlay elects one leader per plane
   * ('gateway' / 'controller') — two seats, one active process each.
   */
  role?: string;
  /** Standby poll cadence while another host holds leadership. */
  retryIntervalMs?: number;
  /** Leadership renewal cadence — same philosophy as the instance lease. */
  renewIntervalMs?: number;
  leaseTtlMs?: number;
  /**
   * The split-brain fence: with no confirmed renewal for (TTL − margin), the
   * leader steps down via the lost hook — strictly before any standby's
   * clock could read the lease as lapsed. Must be positive and below the TTL.
   */
  stepDownMarginMs?: number;
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
  const id = getHostInstanceId();
  if (!id) throw new Error('host leadership requires the instance lease to be started first');
  if (leadership !== 'none') throw new Error('host leadership already established');

  const role = options.role ?? 'all';
  const mode = options.electionMode ?? 'auto';
  if (mode === 'auto' && getDb().dialect === 'sqlite') {
    leadership = 'short-circuit';
    leadershipRole = role;
    return;
  }

  const retryIntervalMs = options.retryIntervalMs ?? LEADER_RETRY_INTERVAL_MS;
  const renewIntervalMs = options.renewIntervalMs ?? RENEW_INTERVAL_MS;
  const leaseTtlMs = options.leaseTtlMs ?? LEASE_TTL_MS;
  // The default margin scales down with a shortened TTL (a third of it, the
  // renewal-cadence ratio) so an explicit small lease keeps a working fence;
  // an EXPLICIT margin must actually fit inside the lease.
  const stepDownMarginMs = options.stepDownMarginMs ?? Math.min(STEP_DOWN_MARGIN_MS, Math.floor(leaseTtlMs / 3));
  if (stepDownMarginMs <= 0 || stepDownMarginMs >= leaseTtlMs) {
    throw new Error(`stepDownMarginMs must be within (0, leaseTtlMs); got ${stepDownMarginMs} of ${leaseTtlMs}`);
  }
  const onLost = options.onLeadershipLost ?? ((code: number) => process.exit(code));

  let announcedStandby = false;
  let acquiredIssuedAt: number;
  for (;;) {
    acquiredIssuedAt = performance.now();
    const acquired = await tryAcquireHostLeadership({
      installId: INSTALL_SLUG,
      role,
      instanceId: id,
      now: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + leaseTtlMs).toISOString(),
    });
    if (acquired) break;
    if (!announcedStandby) {
      log.info('standby: another host holds leadership for this install — waiting for its lease to lapse', {
        installId: INSTALL_SLUG,
        role,
        instanceId: id,
        retryIntervalMs,
      });
      announcedStandby = true;
    }
    await sleep(retryIntervalMs);
  }

  leadership = 'elected';
  leadershipRole = role;
  if (announcedStandby) log.info('standby host took over leadership', { installId: INSTALL_SLUG, role, instanceId: id });
  else log.info('acquired active-host leadership', { installId: INSTALL_SLUG, role, instanceId: id });

  skippedRenewTicks = 0;
  // The acquire itself is the first confirmed write — the fence arms from it.
  confirmLease(acquiredIssuedAt, leaseTtlMs, stepDownMarginMs, onLost);
  leaderRenewTimer = setInterval(() => {
    void _leadershipRenewTick(id, role, leaseTtlMs, stepDownMarginMs, onLost);
  }, renewIntervalMs);
  // Never keep an otherwise-finished process alive for a renewal tick.
  leaderRenewTimer.unref?.();
}

/**
 * One renewal attempt. Single-flight: a tick that finds the previous attempt
 * still on the wire SKIPS (never queues) — overlapping renewals reorder their
 * lease stamps unpredictably, and a backlog of them against a slow database
 * is how a "renewed" lease ends up older than the one it replaced. Exported
 * for the tests, which drive it directly to prove the skip.
 */
export async function _leadershipRenewTick(
  id: string,
  role: string,
  leaseTtlMs: number,
  stepDownMarginMs: number,
  onLost: (code: number) => void,
): Promise<void> {
  if (leadership !== 'elected') return;
  if (renewInFlight) {
    skippedRenewTicks += 1;
    return;
  }
  renewInFlight = true;
  /* eslint-disable no-catch-all/no-catch-all -- a transient renewal error must not kill the host; the step-down fence bounds how long we act unconfirmed */
  try {
    const issuedAt = performance.now();
    const renewed = await renewHostLeadership(INSTALL_SLUG, role, id, new Date(Date.now() + leaseTtlMs).toISOString());
    if (renewed) {
      confirmLease(issuedAt, leaseTtlMs, stepDownMarginMs, onLost);
      return;
    }
    // Row gone or taken. Re-acquire covers our own lapsed-but-unclaimed lease;
    // a live usurper means two hosts believed they were active — stop being one.
    const reacquireIssuedAt = performance.now();
    const reacquired = await tryAcquireHostLeadership({
      installId: INSTALL_SLUG,
      role,
      instanceId: id,
      now: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + leaseTtlMs).toISOString(),
    });
    if (reacquired) {
      log.warn('Leadership lease had lapsed unclaimed — re-acquired', { installId: INSTALL_SLUG, role, instanceId: id });
      confirmLease(reacquireIssuedAt, leaseTtlMs, stepDownMarginMs, onLost);
      return;
    }
    log.error(
      'Lost active-host leadership — another host has taken over; exiting so the supervisor restarts us into standby',
      { installId: INSTALL_SLUG, role, instanceId: id },
    );
    relinquishLeadership();
    onLost(1);
  } catch (err) {
    // No confirmation happened — the step-down fence keeps counting down.
    log.warn('Leadership renewal failed', { installId: INSTALL_SLUG, instanceId: id, err });
  } finally {
    renewInFlight = false;
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

/** Release leadership (prompt handoff): standby hosts acquire on their next retry. */
export async function stopHostLeadership(): Promise<void> {
  const state = leadership;
  relinquishLeadership();
  if (state !== 'elected') return;
  const id = getHostInstanceId();
  if (!id) return;
  /* eslint-disable no-catch-all/no-catch-all -- graceful shutdown must proceed even if the release cannot be written; the lease lapses on its own */
  try {
    await releaseHostLeadership(INSTALL_SLUG, leadershipRole, id);
  } catch (err) {
    log.warn('Failed to release host leadership', { installId: INSTALL_SLUG, role: leadershipRole, instanceId: id, err });
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

// ── boot wiring surface (what the skill's index.ts edits call) ──

/**
 * The one call the boot sequence makes before adoption: start the instance
 * lease (if the base tree hasn't already) and resolve only as the active
 * host. Claims then carry the lease id from the very first adoption pass,
 * and everything below the gate runs on exactly one host per install.
 */
export async function startActiveHostGate(options: HostLeadershipOptions = {}): Promise<void> {
  if (!getHostInstanceId()) await startHostInstanceLease();
  await awaitHostLeadership(options);
}

/** Shutdown counterpart: hand leadership off promptly; the base tree stops the lease itself. */
export async function stopActiveHostGate(): Promise<void> {
  await stopHostLeadership();
}
