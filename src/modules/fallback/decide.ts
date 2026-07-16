import type { FallbackState } from './db.js';

/**
 * Every message that enters the assistant must produce a response or a
 * limit-reached notice within this window (spec rule 15). Also the floor
 * for how long a declared-long-running Bash tool call gets before its
 * message counts as "stuck" rather than "busy".
 */
export const RESPONSE_GUARANTEE_MS = 10 * 60_000;

/** Growing backoff (minutes) between return-to-native probe attempts when the reset time is unknown. Capped at the last entry. */
export const RETURN_BACKOFF_MIN = [5, 10, 20, 40, 60];

/** Next wall-clock time (ms) to retry the native provider, given how many attempts have already failed. */
export function nextRetryAt(retryCount: number, nowMs: number): number {
  const idx = Math.min(retryCount, RETURN_BACKOFF_MIN.length - 1);
  return nowMs + RETURN_BACKOFF_MIN[idx] * 60_000;
}

export type ProbeRowStatus = 'pending' | 'completed' | 'failed' | null;

export interface OverdueTriggerMessage {
  id: string;
  ageMs: number;
}

export interface DecideFallbackSweepParams {
  nowMs: number;
  state: FallbackState;
  /** Status of the outbound row the in-flight return probe is waiting on, if any. */
  probeRowStatus: ProbeRowStatus;
  /** Trigger messages (kind requiring a response) currently claimed/processing, with their claim age. */
  overdueTriggerMessages: OverdueTriggerMessage[];
  /** Longest declared Bash-tool budget among the session's in-flight messages, if any. */
  declaredBashMs?: number;
}

export type FallbackSweepAction =
  | { type: 'none' }
  | { type: 'start-probe' }
  | { type: 'probe-timeout' }
  | { type: 'probe-success' }
  | { type: 'guarantee-breach'; messageIds: string[] };

/**
 * Pure decision function for the two host-sweep hooks (sweepFallbackSession,
 * sweepFallbackReturn). Takes a snapshot of state and returns one action —
 * all side effects (DB writes, container kills, notifications) live in the
 * caller.
 */
export function decideFallbackSweep(params: DecideFallbackSweepParams): FallbackSweepAction {
  const { nowMs, state, probeRowStatus, overdueTriggerMessages, declaredBashMs = 0 } = params;

  // Forced fallback never auto-probes back (spec rule 13) — only a manual
  // `/fallback return` command exits it.
  if (state.active && state.mode === 'forced') {
    return { type: 'none' };
  }

  if (state.active && state.mode === 'auto') {
    if (state.probing) {
      if (probeRowStatus === 'completed') return { type: 'probe-success' };
      if (probeRowStatus === 'failed') return { type: 'probe-timeout' };
      const startedAt = state.probeStartedAt ? Date.parse(state.probeStartedAt) : NaN;
      if (!Number.isNaN(startedAt) && nowMs - startedAt > 10 * 60_000) {
        return { type: 'probe-timeout' };
      }
      return { type: 'none' };
    }

    const dueAtStr = state.nextRetryAt ?? state.resetAt;
    const dueAt = dueAtStr ? Date.parse(dueAtStr) : NaN;
    if (!Number.isNaN(dueAt) && nowMs >= dueAt) {
      return { type: 'start-probe' };
    }
    return { type: 'none' };
  }

  // Fallback not active: check the 10-minute response guarantee. A long
  // declared Bash call isn't "stuck" — extend the threshold to cover it.
  if (!state.active) {
    const threshold = Math.max(RESPONSE_GUARANTEE_MS, declaredBashMs + 60_000);
    const breached = overdueTriggerMessages.filter((m) => m.ageMs > threshold).map((m) => m.id);
    if (breached.length > 0) {
      return { type: 'guarantee-breach', messageIds: breached };
    }
  }

  return { type: 'none' };
}
