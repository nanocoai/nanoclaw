/**
 * Cross-plane DM resolution — how the controller asks and the gateway answers.
 *
 * Recipes overlay module (process-split skill). ensureUserDm's cold path for a
 * resolution-required channel (Slack, Teams…) needs the channel ADAPTER's
 * openDM round-trip, and adapters live only on the gateway plane — a split
 * controller reaching that path logs "no adapter for channel" and reports
 * every not-yet-cached user unreachable. Standing installs never see it
 * because their user_dms rows predate the split; a FRESH box dies on its
 * first provision (measured: the stanford-demo bring-up, PR #323 finding #9,
 * hand-seeded around with one user_dms row).
 *
 * Same doctrine as the wake seam: the request is a row, never RPC. The
 * controller upserts a durable resolution request and adopts the user_dms
 * cache row the gateway persists; the gateway's consumer polls, resolves via
 * the trunk's own ensureUserDm (the adapter is in-process on that plane, so
 * every persistence side effect — messaging_groups find-or-create, user_dms
 * upsert — is identical to the un-split host), then deletes the request. A
 * resolution failure keeps the trunk contract: the controller's bounded wait
 * lapses and the caller sees null, the same "unreachable" answer an
 * in-process openDM failure produces — retry belongs to the operator's
 * re-provision, exactly as before the split.
 *
 * In role 'all' none of this engages: adapters are in-process, the trunk path
 * runs verbatim, and no consumer is started.
 */
import { getDb } from '../../db/connection.js';
import { registerMigration } from '../../db/migrations/index.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getHostInstanceId } from '../../host-instance.js';
import { log } from '../../log.js';
import type { MessagingGroup } from '../../types.js';
import { getUserDm } from '../permissions/db/user-dms.js';

registerMigration({
  // Module migrations order by registration, not version; the field is
  // informational. One row per user: the newest ask wins, and PRIMARY KEY
  // makes a re-request an upsert rather than a queue.
  version: 1,
  name: 'module:process-split:user-dm-resolution-requests',
  async up(db) {
    await db.exec(`
      CREATE TABLE user_dm_resolution_requests (
        user_id TEXT PRIMARY KEY,
        channel_type TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        claimed_by TEXT,
        claimed_at TEXT
      );
    `);
  },
});

/** How long the controller waits for the gateway's answer before reporting
 *  the trunk's "unreachable" null. Bounded by the caller's patience (the
 *  provision job), floored well above the consumer's poll cadence. */
const DEFAULT_WAIT_TOTAL_MS = 15_000;
const DEFAULT_WAIT_POLL_MS = 500;

export interface DmDelegationOptions {
  privacySafeLogs?: boolean;
  totalMs?: number;
  pollMs?: number;
}

/**
 * Controller side: record the durable ask, then adopt the user_dms cache row
 * the gateway persists. Reaching this function already means "no cache row"
 * (ensureUserDm cache-hits before it resolves), so the first row to appear is
 * the gateway's answer.
 */
export async function delegateUserDmResolution(
  userId: string,
  channelType: string,
  options: DmDelegationOptions = {},
): Promise<MessagingGroup | null> {
  const totalMs = options.totalMs ?? DEFAULT_WAIT_TOTAL_MS;
  const pollMs = options.pollMs ?? DEFAULT_WAIT_POLL_MS;
  await getDb().run(
    `INSERT INTO user_dm_resolution_requests (user_id, channel_type, requested_at)
     VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       channel_type = excluded.channel_type,
       requested_at = excluded.requested_at,
       claimed_by = NULL,
       claimed_at = NULL`,
    userId,
    channelType,
    new Date().toISOString(),
  );
  const deadline = Date.now() + totalMs;
  for (;;) {
    const cached = await getUserDm(userId, channelType);
    if (cached) {
      const mg = await getMessagingGroup(cached.messaging_group_id);
      if (mg) return mg;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  log.warn(
    'Cross-plane DM resolution timed out — reporting unreachable (trunk contract; is the gateway plane up?)',
    options.privacySafeLogs ? { channelType, totalMs } : { userId, channelType, totalMs },
  );
  return null;
}

const CONSUMER_POLL_MS = 2_000;
/** A claim older than this is a crashed consumer's; re-claimable. ISO stamps
 *  compared lexicographically, caller clocks — the coordination-table rule. */
const STALE_CLAIM_MS = 60_000;

let consumerTimer: NodeJS.Timeout | null = null;
let consumerBusy = false;

/** Gateway side: serve the controller's durable DM-resolution requests. Runs
 *  only in the split gateway; mirror of the controller's wake consumer. */
export function startDmResolutionConsumer(pollMs: number = CONSUMER_POLL_MS): void {
  if (consumerTimer) throw new Error('DM-resolution consumer already started');
  consumerTimer = setInterval(() => {
    if (consumerBusy) return; // a slow poll must not stack another behind it
    consumerBusy = true;
    void consumeDmResolutionsOnce().finally(() => {
      consumerBusy = false;
    });
  }, pollMs);
  consumerTimer.unref?.();
}

export function stopDmResolutionConsumer(): void {
  if (consumerTimer) {
    clearInterval(consumerTimer);
    consumerTimer = null;
  }
}

interface DmResolutionRequestRow {
  user_id: string;
  channel_type: string;
}

/** One consumer pass. Exported for tests; never throws. */
export async function consumeDmResolutionsOnce(): Promise<void> {
  /* eslint-disable no-catch-all/no-catch-all -- the consumer is a background loop; a failed pass costs latency and the controller's bounded wait covers it */
  try {
    const db = getDb();
    const now = new Date();
    const nowIso = now.toISOString();
    const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS).toISOString();
    const consumerId = getHostInstanceId() ?? 'gateway';
    const pending = await db.all<DmResolutionRequestRow>(
      `SELECT user_id, channel_type FROM user_dm_resolution_requests
       WHERE claimed_at IS NULL OR claimed_at < ? ORDER BY requested_at`,
      staleBefore,
    );
    if (pending.length === 0) return;
    // Lazy import keeps module init acyclic: user-dm.ts imports this module
    // for the controller branch; only the gateway's consumer needs the
    // resolver back.
    const { ensureUserDm } = await import('../permissions/user-dm.js');
    for (const request of pending) {
      const claim = await db.run(
        `UPDATE user_dm_resolution_requests SET claimed_by = ?, claimed_at = ?
         WHERE user_id = ? AND (claimed_at IS NULL OR claimed_at < ?)`,
        consumerId,
        nowIso,
        request.user_id,
        staleBefore,
      );
      if (claim.changes === 0) continue; // another consumer took it
      const resolved = await ensureUserDm(request.user_id);
      if (!resolved) {
        log.warn('Cross-plane DM resolution failed on the gateway plane — the controller will report unreachable', {
          userId: request.user_id,
          channelType: request.channel_type,
        });
      }
      // Delete after the attempt either way: the outcome (the cache row, or
      // its absence at the controller's deadline) IS the answer, and a retry
      // is a fresh operator-initiated request — the trunk's contract.
      await db.run('DELETE FROM user_dm_resolution_requests WHERE user_id = ?', request.user_id);
    }
  } catch (err) {
    log.warn('DM-resolution consumer pass failed', { err });
  }
  /* eslint-enable no-catch-all/no-catch-all */
}
