/**
 * Typed accessors over the host-coordination tables (migration 024) — the
 * only sanctioned readers/writers of `host_instances`, `session_claims`,
 * `delivery_attempts`, and `wake_signals`. Until the authority flip these
 * tables are SHADOW state — callers may dual-write but the in-memory maps in
 * container-runner/delivery remain authoritative, and nothing may change
 * behavior based on a read from here.
 *
 * Timestamps are ISO-8601 UTC strings and are compared lexicographically
 * (the repo-wide rule — no `datetime()` in central SQL). Callers pass `now`
 * so the functions stay clock-free and portable across DB backends.
 */
import { randomUUID } from 'crypto';

import { getDb } from './connection.js';
import { log } from '../log.js';

/**
 * Run a shadow write. Failures log and are swallowed — shadow state must
 * never affect the authoritative path, so no caller may see a throw.
 */
export async function shadowWrite(label: string, write: () => Promise<unknown>): Promise<void> {
  /* eslint-disable no-catch-all/no-catch-all -- shadow writes must never affect the authoritative path */
  try {
    await write();
  } catch (err) {
    log.warn('Coordination shadow write failed', { label, err });
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

export interface HostInstanceRow {
  instance_id: string;
  install_id: string;
  hostname: string | null;
  pid: number | null;
  started_at: string;
  lease_expires_at: string;
  stopped_at: string | null;
}

export interface SessionClaimRow {
  session_id: string;
  incarnation: number;
  claimed_by: string | null;
  claimed_at: string | null;
  container_ref: string | null;
  stop_intent: 'stop' | 'respawn_after_stop' | null;
  updated_at: string;
}

export interface DeliveryAttemptRow {
  message_id: string;
  session_id: string;
  attempts: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  last_error: string | null;
}

export interface WakeSignalRow {
  id: string;
  session_id: string;
  reason: string;
  created_at: string;
  consumed_at: string | null;
  consumed_by: string | null;
}

// ── host_instances ──

export async function registerHostInstance(args: {
  instanceId: string;
  installId: string;
  hostname?: string;
  pid?: number;
  now: string;
  leaseExpiresAt: string;
}): Promise<void> {
  await getDb().run(
    `INSERT INTO host_instances (instance_id, install_id, hostname, pid, started_at, lease_expires_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (instance_id) DO UPDATE SET
       lease_expires_at = excluded.lease_expires_at, stopped_at = NULL`,
    args.instanceId,
    args.installId,
    args.hostname ?? null,
    args.pid ?? null,
    args.now,
    args.leaseExpiresAt,
  );
}

/** Renew the lease. Returns false when the row no longer exists. */
export async function renewHostInstanceLease(instanceId: string, leaseExpiresAt: string): Promise<boolean> {
  const result = await getDb().run(
    'UPDATE host_instances SET lease_expires_at = ? WHERE instance_id = ? AND stopped_at IS NULL',
    leaseExpiresAt,
    instanceId,
  );
  return result.changes > 0;
}

export async function markHostInstanceStopped(instanceId: string, now: string): Promise<void> {
  await getDb().run('UPDATE host_instances SET stopped_at = ? WHERE instance_id = ?', now, instanceId);
}

/**
 * One instance, only if live: not gracefully stopped and lease still ahead of
 * `now`. Undefined for unknown ids (rows from older claimant-id schemes
 * included) — an unknown claimant reads as not-live, which is what lets a
 * claim it holds be taken over.
 */
export async function getLiveHostInstance(instanceId: string, now: string): Promise<HostInstanceRow | undefined> {
  return getDb().get<HostInstanceRow>(
    'SELECT * FROM host_instances WHERE instance_id = ? AND stopped_at IS NULL AND lease_expires_at > ?',
    instanceId,
    now,
  );
}

/** Instances whose lease is still ahead of `now` and not gracefully stopped. */
export async function listLiveHostInstances(now: string): Promise<HostInstanceRow[]> {
  return getDb().all<HostInstanceRow>(
    'SELECT * FROM host_instances WHERE stopped_at IS NULL AND lease_expires_at > ? ORDER BY started_at',
    now,
  );
}

// ── session_claims ──

export async function getSessionClaim(sessionId: string): Promise<SessionClaimRow | undefined> {
  return getDb().get<SessionClaimRow>('SELECT * FROM session_claims WHERE session_id = ?', sessionId);
}

/**
 * The fencing primitive. Bumps the incarnation and takes the claim only when
 * the caller's view of the current incarnation is still true — a stale host
 * (or a stale `finish()` racing a fresh spawn) loses the CAS and must reload.
 * Creating the row (first spawn ever) is the `expectedIncarnation: 0` case.
 * Returns the new incarnation on success, null when the CAS lost.
 */
export async function tryClaimSession(args: {
  sessionId: string;
  instanceId: string;
  expectedIncarnation: number;
  containerRef?: string;
  now: string;
}): Promise<number | null> {
  const db = getDb();
  const next = args.expectedIncarnation + 1;
  if (args.expectedIncarnation === 0) {
    const inserted = await db.run(
      `INSERT INTO session_claims (session_id, incarnation, claimed_by, claimed_at, container_ref, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_id) DO NOTHING`,
      args.sessionId,
      next,
      args.instanceId,
      args.now,
      args.containerRef ?? null,
      args.now,
    );
    if (inserted.changes > 0) return next;
  }
  const updated = await db.run(
    `UPDATE session_claims
     SET incarnation = ?, claimed_by = ?, claimed_at = ?, container_ref = ?, updated_at = ?
     WHERE session_id = ? AND incarnation = ?`,
    next,
    args.instanceId,
    args.now,
    args.containerRef ?? null,
    args.now,
    args.sessionId,
    args.expectedIncarnation,
  );
  return updated.changes > 0 ? next : null;
}

/** Release only if this instance still holds the claim at this incarnation. */
export async function releaseSessionClaim(args: {
  sessionId: string;
  instanceId: string;
  incarnation: number;
  now: string;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE session_claims SET claimed_by = NULL, claimed_at = NULL, container_ref = NULL, updated_at = ?
     WHERE session_id = ? AND claimed_by = ? AND incarnation = ?`,
    args.now,
    args.sessionId,
    args.instanceId,
    args.incarnation,
  );
  return result.changes > 0;
}

/** Sessions carrying an unconsumed stop intent (startup recovery reads this). */
export async function listSessionsWithStopIntent(): Promise<SessionClaimRow[]> {
  return getDb().all<SessionClaimRow>('SELECT * FROM session_claims WHERE stop_intent IS NOT NULL');
}

/** Durable stop intent — survives a host restart, unlike the on-wake promise. */
export async function setStopIntent(
  sessionId: string,
  intent: 'stop' | 'respawn_after_stop' | null,
  now: string,
): Promise<void> {
  await getDb().run(
    `INSERT INTO session_claims (session_id, incarnation, stop_intent, updated_at)
     VALUES (?, 0, ?, ?)
     ON CONFLICT (session_id) DO UPDATE SET stop_intent = excluded.stop_intent, updated_at = excluded.updated_at`,
    sessionId,
    intent,
    now,
  );
}

// ── delivery_attempts ──

/** Record one attempt; returns the new attempt count. */
export async function recordDeliveryAttempt(args: {
  messageId: string;
  sessionId: string;
  now: string;
  nextAttemptAt: string | null;
  error?: string;
}): Promise<number> {
  const db = getDb();
  await db.run(
    `INSERT INTO delivery_attempts (message_id, session_id, attempts, last_attempt_at, next_attempt_at, last_error)
     VALUES (?, ?, 1, ?, ?, ?)
     ON CONFLICT (message_id) DO UPDATE SET
       attempts = delivery_attempts.attempts + 1,
       last_attempt_at = excluded.last_attempt_at,
       next_attempt_at = excluded.next_attempt_at,
       last_error = excluded.last_error`,
    args.messageId,
    args.sessionId,
    args.now,
    args.nextAttemptAt,
    args.error ?? null,
  );
  const row = await db.get<{ attempts: number }>(
    'SELECT attempts FROM delivery_attempts WHERE message_id = ?',
    args.messageId,
  );
  return row?.attempts ?? 1;
}

export async function getDeliveryAttempt(messageId: string): Promise<DeliveryAttemptRow | undefined> {
  return getDb().get<DeliveryAttemptRow>('SELECT * FROM delivery_attempts WHERE message_id = ?', messageId);
}

/** Delivered or terminally failed — the row's job is done. */
export async function clearDeliveryAttempt(messageId: string): Promise<void> {
  await getDb().run('DELETE FROM delivery_attempts WHERE message_id = ?', messageId);
}

// ── wake_signals (the wake-signal outbox) ──

export async function writeWakeSignal(sessionId: string, reason: string, now: string): Promise<string> {
  const id = randomUUID();
  await getDb().run(
    'INSERT INTO wake_signals (id, session_id, reason, created_at) VALUES (?, ?, ?, ?)',
    id,
    sessionId,
    reason,
    now,
  );
  return id;
}

/**
 * Consume pending signals for one session (or all sessions when omitted).
 * Marks them consumed and returns what was taken — each signal is delivered
 * to exactly one consumer.
 */
export async function takeWakeSignals(args: {
  consumerId: string;
  now: string;
  sessionId?: string;
}): Promise<WakeSignalRow[]> {
  const db = getDb();
  const pending = args.sessionId
    ? await db.all<WakeSignalRow>(
        'SELECT * FROM wake_signals WHERE session_id = ? AND consumed_at IS NULL ORDER BY created_at',
        args.sessionId,
      )
    : await db.all<WakeSignalRow>('SELECT * FROM wake_signals WHERE consumed_at IS NULL ORDER BY created_at');
  const taken: WakeSignalRow[] = [];
  for (const signal of pending) {
    const result = await db.run(
      'UPDATE wake_signals SET consumed_at = ?, consumed_by = ? WHERE id = ? AND consumed_at IS NULL',
      args.now,
      args.consumerId,
      signal.id,
    );
    if (result.changes > 0) taken.push({ ...signal, consumed_at: args.now, consumed_by: args.consumerId });
  }
  return taken;
}
