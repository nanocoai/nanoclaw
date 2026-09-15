/**
 * Runner state → session status, as a pure decision.
 *
 * Inputs are two host-side facts per tick: is the coding session's container
 * running (sessions.container_status, kept by the host), and what does the
 * runner's turn stamp say (`<sessDir>/code-turns/state.json`, written by the
 * mailbox hook on UserPromptSubmit/Stop — code-runner/turn-stamp.ts). The
 * output is what, if anything, to send this tick:
 *
 *   container not running        → suspended
 *   running, turn stamp busy     → processing
 *   running, stamp idle or none  → active
 *
 * Three rules shape the sends:
 *   - coalesce: an unchanged status is never re-sent; a changed one waits
 *     until `minIntervalMs` since the last send (flapping is absorbed, the
 *     latest value wins);
 *   - stopped gate: after a Stop from the channel nothing is sent — the
 *     service refuses it anyway — until the runner reports a NEW busy turn
 *     (a stamp newer than the stop mark), which is the next human turn: that
 *     one goes out as `processing` with `resume: true`;
 *   - diff after a turn: a stamp that moved to idle since the last one seen
 *     means a turn completed; the caller renders the diff for it. Never while
 *     stopped or suspended.
 *
 * Pure so the table is testable without timers, files or a service.
 */
import type { SurfaceStatus } from './types.js';

export type MirrorStatus = Exclude<SurfaceStatus, 'closed'>;

export interface TurnStamp {
  state: 'idle' | 'busy';
  at: string;
  seq: number;
}

export interface MirrorObservation {
  running: boolean;
  turn: TurnStamp | null;
}

export function mapStatus(observation: MirrorObservation): MirrorStatus {
  if (!observation.running) return 'suspended';
  return observation.turn?.state === 'busy' ? 'processing' : 'active';
}

export interface MirrorState {
  /** Last status the service accepted (null before the first send). */
  lastStatus: MirrorStatus | null;
  /** Epoch ms of the last accepted send (0 before the first). */
  lastSentAt: number;
  /** ISO time of the Stop from the channel; null while running normally. */
  stoppedAt: string | null;
  /** Highest turn-stamp seq already acted on. */
  lastTurnSeq: number;
}

export interface MirrorDecision {
  /** Send this status now (resume flags the first send after a stop). */
  send?: { status: MirrorStatus; resume: boolean };
  /** A turn completed since the last tick — render the diff for it. */
  renderDiff?: { turnSeq: number };
  /** The state to carry into the next tick (the caller persists what it wants). */
  next: MirrorState;
}

export interface MirrorPolicy {
  /** Minimum gap between two status sends. */
  minIntervalMs: number;
}

export const DEFAULT_MIRROR_POLICY: MirrorPolicy = { minIntervalMs: 1_500 };

function newerThan(turn: TurnStamp | null, iso: string): boolean {
  if (!turn) return false;
  const at = Date.parse(turn.at);
  const mark = Date.parse(iso);
  return Number.isFinite(at) && Number.isFinite(mark) && at > mark;
}

export function decide(
  state: MirrorState,
  observation: MirrorObservation,
  nowMs: number,
  policy: MirrorPolicy = DEFAULT_MIRROR_POLICY,
): MirrorDecision {
  const desired = mapStatus(observation);
  const turn = observation.turn;
  const next: MirrorState = { ...state };
  const decision: MirrorDecision = { next };

  const turnAdvanced = turn !== null && turn.seq > state.lastTurnSeq;
  if (turnAdvanced) next.lastTurnSeq = turn.seq;

  if (state.stoppedAt !== null) {
    // Stopped: only a new human turn — the runner stamping busy AFTER the
    // stop — resumes. Everything else stays silent, suspended included.
    const resumed = observation.running && turn?.state === 'busy' && newerThan(turn, state.stoppedAt);
    if (!resumed) return decision;
    next.stoppedAt = null;
    next.lastStatus = 'processing';
    next.lastSentAt = nowMs;
    decision.send = { status: 'processing', resume: true };
    return decision;
  }

  if (turnAdvanced && turn.state === 'idle' && observation.running) {
    decision.renderDiff = { turnSeq: turn.seq };
  }

  if (desired !== state.lastStatus && nowMs - state.lastSentAt >= policy.minIntervalMs) {
    next.lastStatus = desired;
    next.lastSentAt = nowMs;
    decision.send = { status: desired, resume: false };
  }
  return decision;
}

/** Mark a Stop received from the channel: status sends pause until the next human turn. */
export function markStopped(state: MirrorState, atIso: string): MirrorState {
  return { ...state, stoppedAt: atIso };
}
