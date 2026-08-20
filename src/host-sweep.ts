/**
 * Host sweep — periodic maintenance of all session mailboxes.
 *
 * Reads runner-owned processing/container state and maintains host-owned
 * inbound state through the registered mailbox.
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
 *        When no heartbeat file exists yet, falls back to the tracked
 *        container spawn time so a container that goes idle without ever
 *        reaching an SDK event —
 *        and so never writes a heartbeat — still ages out instead of
 *        living forever (see decideStuckAction's grace-period comment).
 *
 *     2. Message-scoped stuck: for each 'processing' row, tolerance =
 *        max(60s, current_bash_timeout_ms_if_Bash_running). If
 *        (claim_age > tolerance) AND (heartbeat_mtime <= status_changed)
 *        → kill + reset this message + tries++. Semantics: "container
 *        claimed a message and went quiet past tolerance since the claim."
 */
import fs from 'fs';

import { ensureEgressNetwork } from './egress-lockdown.js';
import { getActiveSessions, isTaskThread, updateSession } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import { log } from './log.js';
import { heartbeatPath, withExistingMailboxSession } from './session-manager.js';
import { getContainerStartedAtMs, isContainerRunning, killContainer, wakeContainer } from './container-runner.js';
import type { Session } from './types.js';
import type { ContainerState, InboundMailbox, OutboundMailbox } from './mailbox/index.js';

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

export type StuckDecision =
  | { action: 'ok' }
  | { action: 'kill-ceiling'; heartbeatAgeMs: number; ceilingMs: number }
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

  // Ceiling check prefers the heartbeat file's mtime. A freshly-spawned
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
    const ceiling = Math.max(ABSOLUTE_CEILING_MS, declaredBashMs ?? 0);
    if (heartbeatAge > ceiling) {
      return { action: 'kill-ceiling', heartbeatAgeMs: heartbeatAge, ceilingMs: ceiling };
    }
  }

  const tolerance = Math.max(CLAIM_STUCK_MS, declaredBashMs ?? 0);
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

let running = false;

export function startHostSweep(): void {
  if (running) return;
  running = true;
  void sweep();
}

export function stopHostSweep(): void {
  running = false;
}

async function sweep(): Promise<void> {
  if (!running) return;

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
    const sessions = await getActiveSessions();
    for (const session of sessions) {
      await sweepSession(session);
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

  setTimeout(() => void sweep(), SWEEP_INTERVAL_MS);
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
        await maintainSessionMailbox(mailbox, session, agentGroup.id, false);
      }
      return true;
    });
    if (!exists) return;

    if (!shouldWake) return;

    // Waking refreshes routing through the mailbox. Keep it outside the
    // session transaction so serialized implementations do not re-enter
    // themselves while the sweep still owns the session.
    log.info('Waking container for due messages', { sessionId: session.id, count: dueCount });
    await wakeContainer(session);

    await withExistingMailboxSession(agentGroup.id, session.id, async (mailbox) => {
      await maintainSessionMailbox(mailbox, session, agentGroup.id, true);
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
  justWoke: boolean,
): Promise<void> {
  const alive = isContainerRunning(session.id);
  if (alive && !justWoke) {
    enforceRunningContainerSla(mailbox, mailbox, session, agentGroupId);
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

function enforceRunningContainerSla(
  inDb: InboundMailbox,
  outDb: OutboundMailbox,
  session: Session,
  agentGroupId: string,
): void {
  const decision = decideStuckAction({
    now: Date.now(),
    heartbeatMtimeMs: heartbeatMtimeMs(agentGroupId, session.id),
    containerStartedAtMs: getContainerStartedAtMs(session.id),
    containerState: outDb.getContainerState(),
    claims: outDb.getProcessingClaims(),
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
