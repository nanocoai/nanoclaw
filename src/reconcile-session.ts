/**
 * Per-session reconcile — one session's maintenance pass, extracted from the
 * host sweep so it can run per key instead of only inside the global tick.
 * `reconcileSession(sessionId)` is the `ReconcileFn` shape from
 * src/reconcile.ts: level-triggered, reads current state, a missing or
 * closed session is a clean no-op.
 *
 * Stuck / idle detection (replaces v1's keep-alive `IDLE_TIMEOUT` setTimeout
 * + 10-min heartbeat threshold — note that v1's IDLE_TIMEOUT was the opposite
 * mechanism, holding a container open after its last result; the idle timeout
 * here decides when to kill one):
 *
 *   If the container isn't running and there are 'processing' rows left over
 *   (e.g. it crashed mid-turn) → reset them to pending with backoff +
 *   tries++. Existing retry machinery does the rest.
 *
 *   If the container IS running:
 *     1. Idle timeout: heartbeat age > max(idle timeout, current_bash_timeout)
 *        where the idle timeout is 30 min unless NANOCLAW_IDLE_TIMEOUT_MS
 *        raises it → kill. The heartbeat is touched on every stream event, so
 *        this measures silence — no output and no tool calls — not elapsed
 *        turn time; a turn that keeps producing is never killed here, however
 *        long it runs. Extended only while Bash is declared as running longer,
 *        honouring the user's own timeout directive. Kill then resets
 *        processing rows.
 *        When no heartbeat file exists yet, falls back to the tracked
 *        container spawn time so a container that goes idle without ever
 *        reaching an SDK event —
 *        and so never writes a heartbeat — still ages out instead of
 *        living forever (see decideStuckAction's grace-period comment).
 *
 *     2. Message-scoped stuck: for each 'processing' row, tolerance =
 *        max(60s, current_bash_timeout_ms_if_Bash_running, an explicit
 *        NANOCLAW_IDLE_TIMEOUT_MS). If
 *        (claim_age > tolerance) AND (heartbeat_mtime <= status_changed)
 *        → kill + reset this message + tries++. Semantics: "container
 *        claimed a message and went quiet past tolerance since the claim."
 */
import fs from 'fs';

import { getSessionClaim } from './db/coordination.js';
import { getSession, isTaskThread, updateSession } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import { log } from './log.js';
import { heartbeatPath, withExistingMailboxSession } from './session-manager.js';
import { getContainerStartedAtMs, isContainerRunning, killContainer } from './container-runner.js';
import { requestWake } from './request-wake.js';
import { IDLE_TIMEOUT_MS_RAW } from './config.js';
import { parseIdleTimeoutMs, resolveIdleTimeoutMs } from './idle-timeout.js';
import type { Session } from './types.js';
import type { ContainerState, InboundMailbox, OutboundMailbox } from './mailbox/index.js';

// How long a running container may go with no output and no tool calls before
// it is killed. The heartbeat file is touched on every stream event, so this
// times silence, not turn length: a turn still producing tokens or calling
// tools never trips it, however long it takes. If nothing has touched the
// heartbeat in this long the container is either stuck or doing genuinely
// nothing — kill and restart on the next inbound. 30 minutes unless
// NANOCLAW_IDLE_TIMEOUT_MS raises it, because a slow local-model backend can
// legitimately go longer than 30 min between stream events while actively
// decoding (#3643). Read once at startup: changing it needs a host restart,
// like every other env var.
export const IDLE_TIMEOUT_MS = resolveIdleTimeoutMs(IDLE_TIMEOUT_MS_RAW);
// The operator's explicit setting, or undefined when they set nothing valid.
// Kept apart from IDLE_TIMEOUT_MS so the claim-stuck tolerance below can honour
// a deliberate override without the built-in default silently widening it.
export const IDLE_TIMEOUT_OVERRIDE_MS = parseIdleTimeoutMs(IDLE_TIMEOUT_MS_RAW);
// Stuck tolerance window applied per 'processing' claim — "did we see any
// signs of life since this message was claimed?"
export const CLAIM_STUCK_MS = 60 * 1000;
const MAX_TRIES = 5;
const BACKOFF_BASE_MS = 5000;

export type StuckDecision =
  | { action: 'ok' }
  | { action: 'kill-idle-timeout'; heartbeatAgeMs: number; idleTimeoutMs: number }
  | { action: 'kill-claim'; messageId: string; claimAgeMs: number; toleranceMs: number };

/**
 * Pure decision for whether a running container should be killed this sweep
 * tick. Inputs are all deterministic; filesystem and mailbox reads happen in the
 * caller.
 */
export function decideStuckAction(args: {
  now: number;
  heartbeatMtimeMs: number; // 0 when heartbeat file absent
  containerStartedAtMs?: number; // fallback when heartbeat file absent
  containerState: ContainerState | null;
  claims: Array<{ messageId: string; statusChanged: string }>;
}): StuckDecision {
  const { now, heartbeatMtimeMs, containerStartedAtMs, containerState, claims } = args;
  const declaredBashMs = bashTimeoutMs(containerState);

  // Idle-timeout check prefers the heartbeat file's mtime. A freshly-spawned
  // container hasn't had any SDK activity yet so no heartbeat file exists —
  // if we treated that as infinitely stale we'd kill every container within
  // seconds of spawn. But "no heartbeat file" isn't only a spawn-grace-period
  // signal: a container can also finish its one turn (or find nothing to do)
  // without its poll loop ever reaching an SDK event, in which case a
  // heartbeat file is never created for the rest of that container's life,
  // and it sits alive-but-idle forever, immune to this check. Falling back
  // to the container's spawn timestamp gives fresh spawns the same grace
  // period as before (age starts at ~0) while still aging out a
  // container that never ticks. Genuinely-dead containers that never wrote a
  // heartbeat AND have no session record are caught by the separate
  // "container process not running" cleanup path, not here. If a fresh
  // container is hanging at the gate (claimed a message but never did
  // anything) the claim-stuck check below handles it independently of this
  // fallback.
  const effectiveHeartbeatMs = heartbeatMtimeMs !== 0 ? heartbeatMtimeMs : (containerStartedAtMs ?? 0);
  if (effectiveHeartbeatMs !== 0) {
    const heartbeatAge = now - effectiveHeartbeatMs;
    const idleTimeout = Math.max(IDLE_TIMEOUT_MS, declaredBashMs ?? 0);
    if (heartbeatAge > idleTimeout) {
      return { action: 'kill-idle-timeout', heartbeatAgeMs: heartbeatAge, idleTimeoutMs: idleTimeout };
    }
  }

  // An operator who raises the idle timeout is telling us this backend goes
  // quiet for longer. That applies to a claimed message just as much as to the
  // heartbeat — in fact more so, because the heartbeat is only touched from
  // inside the provider's stream loop, so a backend still doing prompt
  // processing has claimed the message and written no heartbeat at all. Left
  // at a flat 60s this check would kill exactly the containers the raised
  // timeout was meant to protect. Only the explicit override counts, so an
  // install that sets nothing keeps the original 60s tolerance untouched.
  const tolerance = Math.max(CLAIM_STUCK_MS, declaredBashMs ?? 0, IDLE_TIMEOUT_OVERRIDE_MS ?? 0);
  for (const claim of claims) {
    const claimedAt = Date.parse(claim.statusChanged);
    if (Number.isNaN(claimedAt)) continue;
    const claimAge = now - claimedAt;
    if (claimAge <= tolerance) continue;
    if (heartbeatMtimeMs > claimedAt) continue;
    return { action: 'kill-claim', messageId: claim.messageId, claimAgeMs: claimAge, toleranceMs: tolerance };
  }

  return { action: 'ok' };
}

/** A per-task session with no live tasks and no running container is spent → close it. */
export function shouldCloseTaskSession(
  threadId: string | null,
  containerRunning: boolean,
  liveTaskCount: number,
): boolean {
  return isTaskThread(threadId) && !containerRunning && liveTaskCount === 0;
}

/** Reconcile one session against current state. Missing/closed sessions no-op. */
export async function reconcileSession(sessionId: string): Promise<void> {
  const session = await getSession(sessionId);
  if (!session || session.status !== 'active') return;
  await reconcileActiveSession(session);
}

async function reconcileActiveSession(session: Session): Promise<void> {
  const agentGroup = await getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  try {
    let dueCount = 0;
    let shouldWake = false;
    const exists = await withExistingMailboxSession(agentGroup.id, session.id, async (mailbox) => {
      mailbox.applyProcessingAcks(mailbox.getTerminalProcessingAcks());
      dueCount = mailbox.countDueMessages();
      shouldWake = dueCount > 0 && !isContainerRunning(session.id);
      if (!shouldWake) {
        await maintainSessionMailbox(mailbox, session, agentGroup.id);
      }
      return true;
    });
    if (!exists) return;

    if (!shouldWake) return;

    // Waking refreshes routing through the mailbox. Keep it outside the
    // session transaction so serialized implementations do not re-enter
    // themselves while the sweep still owns the session.
    log.info('Waking container for due messages', { sessionId: session.id, count: dueCount });
    await requestWake(session, 'due-message');

    await withExistingMailboxSession(agentGroup.id, session.id, async (mailbox) => {
      await maintainSessionMailbox(mailbox, session, agentGroup.id);
    });
  } catch (err) {
    log.error('Session mailbox sweep failed', {
      agentGroupId: agentGroup.id,
      sessionId: session.id,
      err,
    });
  }
}

async function maintainSessionMailbox(
  mailbox: InboundMailbox & OutboundMailbox,
  session: Session,
  agentGroupId: string,
): Promise<void> {
  const alive = isContainerRunning(session.id);
  if (alive) {
    await enforceRunningContainerSla(mailbox, mailbox, session, agentGroupId);
  }
  if (!alive) {
    resetStuckProcessingRows(mailbox, mailbox, session, 'container not running');
  }

  // MODULE-HOOK:scheduling-recurrence:start
  const { handleRecurrence } = await import('./modules/scheduling/recurrence.js');
  await handleRecurrence(mailbox, session);
  // MODULE-HOOK:scheduling-recurrence:end

  if (isTaskThread(session.thread_id)) {
    const liveTasks = mailbox.countLiveTasks();
    if (shouldCloseTaskSession(session.thread_id, isContainerRunning(session.id), liveTasks)) {
      await updateSession(session.id, { status: 'closed' });
      log.info('Closed spent task session', { sessionId: session.id, threadId: session.thread_id });
    }
  }

  // MODULE-HOOK:cross-session-echo-prune:start
  try {
    const { pruneEchoBacklog } = await import('./modules/cross-session-context/index.js');
    const pruned = pruneEchoBacklog(mailbox);
    if (pruned > 0) log.info('Pruned session-echo backlog', { sessionId: session.id, pruned });
  } catch (err) {
    log.error('Echo backlog prune failed', { sessionId: session.id, err });
  }
  // MODULE-HOOK:cross-session-echo-prune:end
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
  if (!state || state.currentTool !== 'Bash') return null;
  return state.toolDeclaredTimeoutMs;
}

/**
 * The incarnation gate: evidence that predates the current incarnation's
 * durable claim time is not evidence against this container. A heartbeat
 * mtime older than the claim is the previous incarnation's file — treated as
 * absent, so the spawn-time fallback gives the fresh container its grace. A
 * processing claim older than the claim time was inherited from a crashed
 * predecessor — its age is measured from this incarnation's start, so the
 * fresh container gets a full tolerance window to clear it before it can
 * kill. Replaces the old wake-tick grace flag: the fence is a durable fact
 * about when this incarnation began, not volatile "we just woke it"
 * bookkeeping — it survives restarts and applies on every pass, not only the
 * one that issued the wake.
 */
async function enforceRunningContainerSla(
  inDb: InboundMailbox,
  outDb: OutboundMailbox,
  session: Session,
  agentGroupId: string,
): Promise<void> {
  let incarnationStartMs = 0;
  const claimRow = await getSessionClaim(session.id);
  if (claimRow?.claimed_at) {
    const parsed = Date.parse(claimRow.claimed_at);
    if (!Number.isNaN(parsed)) incarnationStartMs = parsed;
  }

  const rawHeartbeatMs = heartbeatMtimeMs(agentGroupId, session.id);
  const gatedHeartbeatMs = rawHeartbeatMs >= incarnationStartMs ? rawHeartbeatMs : 0;
  const gatedClaims = outDb.getProcessingClaims().map((claim) => {
    const claimedAt = Date.parse(claim.statusChanged);
    if (Number.isNaN(claimedAt) || claimedAt >= incarnationStartMs) return claim;
    return { ...claim, statusChanged: new Date(incarnationStartMs).toISOString() };
  });

  const decision = decideStuckAction({
    now: Date.now(),
    heartbeatMtimeMs: gatedHeartbeatMs,
    containerStartedAtMs: getContainerStartedAtMs(session.id),
    containerState: outDb.getContainerState(),
    claims: gatedClaims,
  });

  if (decision.action === 'ok') return;

  if (decision.action === 'kill-idle-timeout') {
    log.warn('Killing container — no output or tool calls past the idle timeout', {
      sessionId: session.id,
      heartbeatAgeMs: decision.heartbeatAgeMs,
      idleTimeoutMs: decision.idleTimeoutMs,
    });
    killContainer(session.id, 'idle-timeout');
    resetStuckProcessingRows(inDb, outDb, session, 'idle-timeout');
    return;
  }

  log.warn('Killing container — message claimed then silent', {
    sessionId: session.id,
    messageId: decision.messageId,
    claimAgeMs: decision.claimAgeMs,
    toleranceMs: decision.toleranceMs,
  });
  killContainer(session.id, 'claim-stuck');
  resetStuckProcessingRows(inDb, outDb, session, 'claim-stuck');
}

export function _resetStuckProcessingRowsForTesting(
  inDb: InboundMailbox,
  outDb: OutboundMailbox,
  session: Session,
  reason: string,
): void {
  resetStuckProcessingRows(inDb, outDb, session, reason);
}

function resetStuckProcessingRows(
  inDb: InboundMailbox,
  outDb: OutboundMailbox,
  session: Session,
  reason: string,
): void {
  const claims = outDb.getProcessingClaims();
  const now = Date.now();
  for (const { messageId } of claims) {
    const msg = inDb.getMessageForRetry(messageId, 'pending');
    if (!msg) continue;

    // Already rescheduled for a future retry — don't bump tries again. The
    // wake path (sweep step 2) will fire when process_after elapses and a
    // fresh container will clean the orphan claim on startup.
    if (msg.processAfter && Date.parse(msg.processAfter) > now) continue;

    if (msg.tries >= MAX_TRIES) {
      inDb.markMessageFailed(msg.id);
      log.warn('Message marked as failed after max retries', {
        messageId: msg.id,
        sessionId: session.id,
        reason,
      });
    } else {
      const backoffMs = BACKOFF_BASE_MS * Math.pow(2, msg.tries);
      const backoffSec = Math.floor(backoffMs / 1000);
      inDb.retryWithBackoff(msg.id, backoffSec);
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
  try {
    const cleared = outDb.deleteOrphanProcessingClaims();
    if (cleared > 0) {
      log.info('Cleared orphan processing claims', { sessionId: session.id, cleared, reason });
    }
  } catch (err) {
    log.warn('Failed to clear orphan processing claims', { sessionId: session.id, err });
  }
}
