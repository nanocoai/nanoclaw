/**
 * Host sweep — periodic maintenance of all session DBs.
 *
 * Two-DB architecture:
 *   - Reads processing_ack + container_state from outbound.db
 *   - Writes to inbound.db (host-owned) for status updates + recurrence
 *   - Uses heartbeat file mtime for liveness (never polls DB for it)
 *   - Never writes to outbound.db — preserves single-writer-per-file invariant
 *
 * Stuck / idle detection (replaces the old IDLE_TIMEOUT setTimeout + 10-min
 * heartbeat threshold):
 *
 *   If the container isn't running and there are 'processing' rows left over
 *   (e.g. it crashed mid-turn) → reset them to pending with backoff +
 *   tries++. Existing retry machinery does the rest.
 *
 *   If the container IS running:
 *     1. Absolute ceiling: heartbeat age > max(30 min, current_bash_timeout)
 *        → kill. Covers the "alive but silent for 30 min" case. Extended
 *        only while Bash is declared as running longer, honouring the
 *        user's own timeout directive. Kill then resets processing rows.
 *
 *     2. Message-scoped stuck: for each 'processing' row, tolerance =
 *        max(60s, current_bash_timeout_ms_if_Bash_running). If
 *        (claim_age > tolerance) AND (heartbeat_mtime <= status_changed)
 *        → kill + reset this message + tries++. Semantics: "container
 *        claimed a message and went quiet past tolerance since the claim."
 */
import type Database from 'better-sqlite3';
import fs from 'fs';

import { ensureEgressNetwork } from './egress-lockdown.js';
import { getActiveSessions, isTaskThread, updateSession } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import {
  countDueMessages,
  deleteOrphanProcessingClaims,
  getContainerState,
  getMessageForRetry,
  getProcessingClaims,
  markMessageFailed,
  retryWithBackoff,
  syncProcessingAcks,
  type ContainerState,
} from './db/session-db.js';
import { log } from './log.js';
import { openInboundDb, openOutboundDb, openOutboundDbRw, inboundDbPath, heartbeatPath } from './session-manager.js';
import { getLastWakeError, isContainerRunning, killContainer, wakeContainer } from './container-runner.js';
import { getDeliveryAdapter } from './delivery.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import { pickApprovalDelivery, pickApprover } from './modules/approvals/primitive.js';
import type { AgentGroup, Session } from './types.js';

/**
 * SQLite TIMESTAMP columns store UTC without a timezone marker. Date.parse
 * treats timezoneless ISO strings as local time, so on non-UTC hosts every
 * timestamp looks (TZ offset) hours stale — leading to spurious kill-claim
 * decisions on freshly-claimed messages. Append "Z" when no zone marker is
 * present so Date.parse interprets the string as UTC.
 */
export function parseSqliteUtc(s: string): number {
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z');
}

const SWEEP_INTERVAL_MS = 60_000;
// Absolute idle ceiling for a running container. If the heartbeat file hasn't
// been touched in this long, the container is either stuck or doing genuinely
// nothing — kill and restart on the next inbound.
export const ABSOLUTE_CEILING_MS = 30 * 60 * 1000;
// Stuck tolerance window applied per 'processing' claim — "did we see any
// signs of life since this message was claimed?"
export const CLAIM_STUCK_MS = 60 * 1000;
const MAX_TRIES = 5;
const BACKOFF_BASE_MS = 5000;

// Consecutive wakeContainer failures (one sweep tick ~= SWEEP_INTERVAL_MS
// apart) before we DM an admin. 3 ticks ~= 3 min — long enough to ride out a
// single transient blip without paging anyone, short enough that an actual
// outage (e.g. OneCLI cloud down) doesn't burn an hour silently.
const WAKE_FAILURE_ALERT_THRESHOLD = 3;
// Once alerted, re-alert every this-many further failures (~10 min) so a
// long outage isn't silent, without pinging every single tick.
const WAKE_FAILURE_REALERT_EVERY = 10;

export type StuckDecision =
  | { action: 'ok' }
  | { action: 'kill-ceiling'; heartbeatAgeMs: number; ceilingMs: number }
  | { action: 'kill-claim'; messageId: string; claimAgeMs: number; toleranceMs: number };

/**
 * Pure decision for whether a running container should be killed this sweep
 * tick. Inputs are all deterministic; filesystem + DB reads happen in the
 * caller.
 */
export function decideStuckAction(args: {
  now: number;
  heartbeatMtimeMs: number; // 0 when heartbeat file absent
  containerState: ContainerState | null;
  claims: Array<{ message_id: string; status_changed: string }>;
}): StuckDecision {
  const { now, heartbeatMtimeMs, containerState, claims } = args;
  const declaredBashMs = bashTimeoutMs(containerState);

  // Ceiling check only applies when we have an actual heartbeat timestamp.
  // A freshly-spawned container hasn't had any SDK activity yet so no
  // heartbeat file exists — if we treated that as infinitely stale we'd
  // kill every container within seconds of spawn. Genuinely-dead containers
  // that never wrote a heartbeat are caught by the separate "container
  // process not running" cleanup path, not here. If a fresh container is
  // hanging at the gate (claimed a message but never did anything) the
  // claim-stuck check below handles it.
  if (heartbeatMtimeMs !== 0) {
    const heartbeatAge = now - heartbeatMtimeMs;
    const ceiling = Math.max(ABSOLUTE_CEILING_MS, declaredBashMs ?? 0);
    if (heartbeatAge > ceiling) {
      return { action: 'kill-ceiling', heartbeatAgeMs: heartbeatAge, ceilingMs: ceiling };
    }
  }

  const tolerance = Math.max(CLAIM_STUCK_MS, declaredBashMs ?? 0);
  for (const claim of claims) {
    const claimedAt = parseSqliteUtc(claim.status_changed);
    if (Number.isNaN(claimedAt)) continue;
    const claimAge = now - claimedAt;
    if (claimAge <= tolerance) continue;
    if (heartbeatMtimeMs > claimedAt) continue;
    return { action: 'kill-claim', messageId: claim.message_id, claimAgeMs: claimAge, toleranceMs: tolerance };
  }

  return { action: 'ok' };
}

let running = false;
// Timestamp of the last sweep() completion. Used to detect the sweep loop
// itself stalling (e.g. a slow synchronous call blocking the event loop, or
// a session's async work taking far longer than expected) — diagnostic aid
// for cases where host-side stuck-detection fires much later than its
// nominal ~SWEEP_INTERVAL_MS + tolerance SLA.
let lastSweepEndedAt: number | null = null;

export function startHostSweep(): void {
  if (running) return;
  running = true;
  sweep();
}

export function stopHostSweep(): void {
  running = false;
}

async function sweep(): Promise<void> {
  if (!running) return;

  const tickStart = Date.now();
  if (lastSweepEndedAt !== null) {
    const gap = tickStart - lastSweepEndedAt;
    // Anything past 2x the interval means something delayed scheduling of
    // this tick — either a slow session sweep or the process was blocked.
    if (gap > SWEEP_INTERVAL_MS * 2) {
      log.warn('Host sweep tick delayed', { gapMs: gap, expectedMs: SWEEP_INTERVAL_MS });
    }
  }

  // Re-heal the egress network so already-running agents keep their gateway hop
  // if it was detached out-of-band. Best-effort here: a heal failure isn't a
  // leak (agents stay on the internal net), so log and continue. No-op when
  // lockdown is disabled.
  try {
    ensureEgressNetwork();
  } catch (err) {
    log.error('Egress lockdown re-heal failed', { err });
  }

  try {
    const sessions = getActiveSessions();
    for (const session of sessions) {
      const sessionStart = Date.now();
      await sweepSession(session);
      const elapsed = Date.now() - sessionStart;
      if (elapsed > 5000) {
        log.warn('Slow sweepSession', { sessionId: session.id, elapsedMs: elapsed });
      }
    }
  } catch (err) {
    log.error('Host sweep error', { err });
  }

  // Finalize any "Reject with reason…" holds whose reply window elapsed (admin
  // ghosted, or the host restarted mid-capture). Central-DB scan, once per tick
  // — not per session.
  // MODULE-HOOK:approvals-reason-sweep:start
  try {
    const { sweepAwaitingReasonRejects } = await import('./modules/approvals/index.js');
    await sweepAwaitingReasonRejects();
  } catch (err) {
    log.error('Reject-with-reason sweep failed', { err });
  }
  // MODULE-HOOK:approvals-reason-sweep:end

  lastSweepEndedAt = Date.now();
  setTimeout(sweep, SWEEP_INTERVAL_MS);
}

/** A per-task session with no live tasks and no running container is spent → close it. */
export function shouldCloseTaskSession(
  threadId: string | null,
  containerRunning: boolean,
  liveTaskCount: number,
): boolean {
  return isTaskThread(threadId) && !containerRunning && liveTaskCount === 0;
}

async function sweepSession(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  const inPath = inboundDbPath(agentGroup.id, session.id);
  if (!fs.existsSync(inPath)) return;

  let inDb: Database.Database;
  let outDb: Database.Database | null = null;
  try {
    inDb = openInboundDb(agentGroup.id, session.id);
  } catch {
    return;
  }

  try {
    outDb = openOutboundDb(agentGroup.id, session.id);
  } catch {
    // outbound.db might not exist yet (container hasn't started)
  }

  try {
    // 1. Sync processing_ack → messages_in status
    if (outDb) {
      syncProcessingAcks(inDb, outDb);
    }

    // 2. Wake a container if work is due and nothing is running. Ordered
    // before the crashed-container cleanup so a fresh container gets a chance
    // to clean its own orphan processing_ack rows on startup (see
    // container/agent-runner/src/db/connection.ts). Otherwise the reset path
    // would keep bumping process_after into the future, dueCount would stay 0,
    // and the wake would never fire.
    const dueCount = countDueMessages(inDb);
    let justWoke = false;
    if (dueCount > 0 && !isContainerRunning(session.id)) {
      log.info('Waking container for due messages', { sessionId: session.id, count: dueCount });
      // wakeContainer never throws — transient spawn failures (OneCLI down,
      // etc.) return false and leave messages pending for the next tick.
      const woke = await wakeContainer(session);
      await trackWakeOutcome(session, agentGroup, woke);
      justWoke = true;
    } else if (isContainerRunning(session.id)) {
      // Container is up via some other path (e.g. router woke it directly on
      // inbound) — treat as recovery for streak/alert purposes.
      await trackWakeOutcome(session, agentGroup, true);
    }

    const alive = isContainerRunning(session.id);

    // 3. Running-container SLA: absolute ceiling + per-claim stuck rules.
    // Skip on the same iteration that just woke the container — it hasn't
    // had a chance to clear stale processing_ack rows from a previous crash
    // yet. Without this grace period, stale claims cause an immediate
    // spawn-kill loop.
    if (alive && outDb && !justWoke) {
      enforceRunningContainerSla(inDb, outDb, session, agentGroup.id);
    }

    // 4. Crashed-container cleanup: processing rows left behind get retried.
    // Only fires when wake in step 2 didn't pick up the work (no due messages,
    // or wake failed). resetStuckProcessingRows itself is idempotent — it
    // skips messages already scheduled for a future retry.
    if (!alive && outDb) {
      resetStuckProcessingRows(inDb, outDb, session, 'container not running');
    }

    // 5. Recurrence fanout for completed recurring tasks.
    // MODULE-HOOK:scheduling-recurrence:start
    const { handleRecurrence } = await import('./modules/scheduling/recurrence.js');
    await handleRecurrence(inDb, session);
    // MODULE-HOOK:scheduling-recurrence:end

    // 6. GC spent task sessions. An isolated per-task session with no live task
    // rows left (one-shot fired, or all cancelled/deleted) and no container
    // running is dead — close it so it stops being swept and listed. Runs after
    // recurrence so a just-fired recurring series has already re-armed its next
    // pending row and is never collected. The per-task log file in the workspace
    // is the durable history and survives the close.
    if (isTaskThread(session.thread_id)) {
      const liveTasks = (
        inDb
          .prepare("SELECT COUNT(*) AS c FROM messages_in WHERE kind = 'task' AND status IN ('pending', 'paused')")
          .get() as { c: number }
      ).c;
      if (shouldCloseTaskSession(session.thread_id, isContainerRunning(session.id), liveTasks)) {
        updateSession(session.id, { status: 'closed' });
        log.info('Closed spent task session', { sessionId: session.id, threadId: session.thread_id });
      }
    }
  } finally {
    inDb.close();
    outDb?.close();
  }
}

// Consecutive wakeContainer failure count per session, and whether we've
// already sent an admin alert for the current outage (cleared on recovery).
const wakeFailureStreaks = new Map<string, number>();
const wakeFailureAlerted = new Set<string>();

async function trackWakeOutcome(session: Session, agentGroup: AgentGroup, woke: boolean): Promise<void> {
  if (woke) {
    if (wakeFailureAlerted.has(session.id)) {
      wakeFailureAlerted.delete(session.id);
      await sendWakeAlert(session, agentGroup, 0, true);
    }
    wakeFailureStreaks.delete(session.id);
    return;
  }

  const streak = (wakeFailureStreaks.get(session.id) ?? 0) + 1;
  wakeFailureStreaks.set(session.id, streak);

  const pastThreshold = streak - WAKE_FAILURE_ALERT_THRESHOLD;
  const shouldAlert = pastThreshold === 0 || (pastThreshold > 0 && pastThreshold % WAKE_FAILURE_REALERT_EVERY === 0);

  if (shouldAlert) {
    wakeFailureAlerted.add(session.id);
    await sendWakeAlert(session, agentGroup, streak, false);
  }
}

/** DM the reachable admin/owner about a stuck container wake. Best-effort — never throws. */
async function sendWakeAlert(
  session: Session,
  agentGroup: AgentGroup,
  streak: number,
  recovered: boolean,
): Promise<void> {
  try {
    const approvers = pickApprover(session.agent_group_id);
    if (approvers.length === 0) return;

    const originChannelType = session.messaging_group_id
      ? (getMessagingGroup(session.messaging_group_id)?.channel_type ?? '')
      : '';
    const target = await pickApprovalDelivery(approvers, originChannelType);
    if (!target) return;

    const adapter = getDeliveryAdapter();
    if (!adapter) return;

    const text = recovered
      ? `✅ NanoClaw: container wake recovered for "${agentGroup.name}" — it was stuck retrying for a while, replies should be flowing again now.`
      : `⚠️ NanoClaw: container for "${agentGroup.name}" has failed to start ${streak} times in a row (~${streak} min). Messages are queued and will keep retrying automatically, but nothing will get a reply until this clears.\nLast error: ${getLastWakeError(session.id) ?? 'unknown'}`;

    await adapter.deliver(
      target.messagingGroup.channel_type,
      target.messagingGroup.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({ text }),
    );
    log.info('Sent wake-failure admin alert', { sessionId: session.id, streak, recovered, to: target.userId });
  } catch (err) {
    log.error('Failed to send wake-failure alert', { sessionId: session.id, err });
  }
}

function heartbeatMtimeMs(agentGroupId: string, sessionId: string): number {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    return fs.statSync(hbPath).mtimeMs;
  } catch {
    return 0;
  }
}

function bashTimeoutMs(state: ContainerState | null): number | null {
  if (!state || state.current_tool !== 'Bash') return null;
  return typeof state.tool_declared_timeout_ms === 'number' ? state.tool_declared_timeout_ms : null;
}

// Tracks when the host first observed each processing claim, keyed by
// "sessionId:messageId". Lets us log the moment a claim shows up (independent
// of the DB's own status_changed timestamp) so a slow/stalled sweep loop is
// visible in the logs rather than only showing up as a large claimAgeMs on
// the eventual kill.
const seenClaimsAt = new Map<string, number>();

function trackClaimSightings(session: Session, claims: { message_id: string }[]): void {
  const now = Date.now();
  const currentIds = new Set(claims.map((c) => `${session.id}:${c.message_id}`));

  for (const claim of claims) {
    const key = `${session.id}:${claim.message_id}`;
    if (!seenClaimsAt.has(key)) {
      seenClaimsAt.set(key, now);
      log.debug('Host first observed processing claim', { sessionId: session.id, messageId: claim.message_id });
    }
  }

  // Drop entries for claims that are no longer processing (completed, reset,
  // or killed) so this map doesn't grow unbounded.
  for (const key of seenClaimsAt.keys()) {
    if (key.startsWith(`${session.id}:`) && !currentIds.has(key)) {
      seenClaimsAt.delete(key);
    }
  }
}

function enforceRunningContainerSla(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  agentGroupId: string,
): void {
  const claims = getProcessingClaims(outDb);
  trackClaimSightings(session, claims);

  const decision = decideStuckAction({
    now: Date.now(),
    heartbeatMtimeMs: heartbeatMtimeMs(agentGroupId, session.id),
    containerState: getContainerState(outDb),
    claims,
  });

  if (decision.action === 'ok') return;

  if (decision.action === 'kill-ceiling') {
    log.warn('Killing container past absolute ceiling', {
      sessionId: session.id,
      heartbeatAgeMs: decision.heartbeatAgeMs,
      ceilingMs: decision.ceilingMs,
    });
    killContainer(session.id, 'absolute-ceiling');
    resetStuckProcessingRows(inDb, outDb, session, 'absolute-ceiling');
    return;
  }

  const firstSeenAt = seenClaimsAt.get(`${session.id}:${decision.messageId}`);
  log.warn('Killing container — message claimed then silent', {
    sessionId: session.id,
    messageId: decision.messageId,
    claimAgeMs: decision.claimAgeMs,
    toleranceMs: decision.toleranceMs,
    // Time since the host's own sweep loop first observed this claim —
    // compare against claimAgeMs (DB-reported) to tell apart "the claim was
    // genuinely stale the whole time" from "the sweep loop itself was slow
    // to notice/re-check it".
    hostObservedAgeMs: firstSeenAt !== undefined ? Date.now() - firstSeenAt : null,
  });
  killContainer(session.id, 'claim-stuck');
  resetStuckProcessingRows(inDb, outDb, session, 'claim-stuck');
}

export function _resetStuckProcessingRowsForTesting(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  reason: string,
): void {
  resetStuckProcessingRows(inDb, outDb, session, reason, outDb);
}

function resetStuckProcessingRows(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  reason: string,
  writableOutDb?: Database.Database,
): void {
  const claims = getProcessingClaims(outDb);
  const now = Date.now();
  for (const { message_id } of claims) {
    const msg = getMessageForRetry(inDb, message_id, 'pending');
    if (!msg) continue;

    // Already rescheduled for a future retry — don't bump tries again. The
    // wake path (sweep step 2) will fire when process_after elapses and a
    // fresh container will clean the orphan claim on startup.
    if (msg.processAfter && parseSqliteUtc(msg.processAfter) > now) continue;

    if (msg.tries >= MAX_TRIES) {
      markMessageFailed(inDb, msg.id);
      log.warn('Message marked as failed after max retries', {
        messageId: msg.id,
        sessionId: session.id,
        reason,
      });
    } else {
      const backoffMs = BACKOFF_BASE_MS * Math.pow(2, msg.tries);
      const backoffSec = Math.floor(backoffMs / 1000);
      retryWithBackoff(inDb, msg.id, backoffSec);
      log.info('Reset stale message with backoff', {
        messageId: msg.id,
        tries: msg.tries,
        backoffMs,
        reason,
      });
    }
  }

  // Drop the orphan 'processing' rows. Without this, the next sweep tick
  // would re-read them, see the old status_changed timestamp, conclude the
  // freshly respawned container is stuck, and SIGKILL it before its
  // agent-runner has a chance to run clearStaleProcessingAcks() on startup.
  const ownsDb = !writableOutDb;
  let useDb: Database.Database | null = writableOutDb ?? null;
  try {
    if (!useDb) useDb = openOutboundDbRw(session.agent_group_id, session.id);
    const cleared = deleteOrphanProcessingClaims(useDb);
    if (cleared > 0) {
      log.info('Cleared orphan processing claims', { sessionId: session.id, cleared, reason });
    }
  } catch (err) {
    log.warn('Failed to clear orphan processing claims', { sessionId: session.id, err });
  } finally {
    if (ownsDb) useDb?.close();
  }
}
