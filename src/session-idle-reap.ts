/**
 * Idle semantics per session kind (composed by the session-idle-reap skill).
 *
 * A scheduled-task session's canonical finish point is "queue drained, no
 * claim in flight": the run's last processing row has acked and nothing is
 * due. Holding the container past that point buys nothing — the next run
 * wakes a fresh one — so it is reaped after a short quiet grace instead of
 * aging into the 30-minute stuck ceiling.
 *
 * A conversation session (DM or channel) stays warm for follow-ups, but only
 * for IDLE_REAP_MS (default five minutes) of true idleness under the same
 * drained conditions.
 *
 * Stuck detection is untouched: a session with outstanding claims belongs to
 * decideStuckAction and its bash-timeout tolerances, never to this module.
 */
import fs from 'fs';

import { isTaskThread } from './db/sessions.js';
import { heartbeatPath } from './session-manager.js';
import { getContainerStartedAtMs, isContainerRunning, killContainer } from './container-runner.js';
import { log } from './log.js';
import type { Session } from './types.js';
import type { InboundMailbox, OutboundMailbox } from './mailbox/index.js';

/** Quiet grace after a task run drains before its container is reaped. */
export const TASK_FINISH_QUIET_MS = 30 * 1000;
/** True-idle ceiling for conversation sessions. */
export const IDLE_REAP_MS = (() => {
  const raw = Number(process.env.NANOCO_SESSION_IDLE_REAP_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60 * 1000;
})();

export type IdleReapDecision = 'keep' | 'reap-task-finished' | 'reap-idle';

/**
 * Pure decision: reap only a RUNNING container that is truly drained —
 * nothing due, no claim in flight — and quiet past its kind's window.
 * `lastAliveMs` is max(heartbeat mtime, container spawn); 0 means unknown,
 * which always keeps.
 */
export function decideIdleReap(args: {
  now: number;
  isTask: boolean;
  dueCount: number;
  claimCount: number;
  lastAliveMs: number;
}): IdleReapDecision {
  const { now, isTask, dueCount, claimCount, lastAliveMs } = args;
  if (dueCount > 0 || claimCount > 0 || lastAliveMs === 0) return 'keep';
  const quiet = now - lastAliveMs;
  if (isTask) return quiet > TASK_FINISH_QUIET_MS ? 'reap-task-finished' : 'keep';
  return quiet > IDLE_REAP_MS ? 'reap-idle' : 'keep';
}

/** The seam entry, called from the per-session sweep while the mailbox is open. */
export function reapIdleSession(
  mailbox: InboundMailbox & OutboundMailbox,
  session: Session,
  agentGroupId: string,
): void {
  if (!isContainerRunning(session.id)) return;
  let heartbeatMs = 0;
  try {
    heartbeatMs = fs.statSync(heartbeatPath(agentGroupId, session.id)).mtimeMs;
  } catch {
    heartbeatMs = 0;
  }
  const decision = decideIdleReap({
    now: Date.now(),
    isTask: isTaskThread(session.thread_id),
    dueCount: mailbox.countDueMessages(),
    claimCount: mailbox.getProcessingClaims().length,
    lastAliveMs: Math.max(heartbeatMs, getContainerStartedAtMs(session.id) ?? 0),
  });
  if (decision === 'keep') return;
  log.info(
    decision === 'reap-task-finished'
      ? 'Task run finished; reaping container at its canonical finish point'
      : 'Conversation idle past the reap window; reaping container',
    { sessionId: session.id, threadId: session.thread_id, decision },
  );
  killContainer(session.id, decision);
}
