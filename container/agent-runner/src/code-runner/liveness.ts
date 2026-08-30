/**
 * D14 liveness lease — the decision half of the code runner's heartbeat.
 *
 * The chat runner earns its heartbeat by doing work; the code runner's PTY
 * is eternally "up", so an unconditional heartbeat would make the container
 * immortal and host-sweep's 30-min kill ceiling dead code. Instead the
 * runner holds a lease: the heartbeat is refreshed only while something
 * observable says the session is in use — a busy agent turn (capped by the
 * same 30-min staleness ceiling the mailbox applies to 'busy', extended
 * through a tool call's DECLARED timeout, since no hook fires mid-call), or
 * any activity within the idle TTL.
 *
 * An attach SOCKET is deliberately not a lease: `docker exec` /
 * `kubectl exec` orphans survive a dead ssh session indefinitely (the shim
 * holds the pty; the in-container client never sees EOF), so a bare socket
 * would reopen the exact immortality D14 exists to close. Under tmux that
 * objection dissolves — sessions live in a tmux server, tmux knows its REAL
 * clients and their per-client activity times, and a dead ssh leaves no tmux
 * client behind — so a live client IS a lease (v2, ratified 2026-08-22:
 * "keep alive on connection; a longer TTL for idle connection"), with its
 * own, longer idle window for a connected-but-silent operator. A client that
 * vanishes contributes nothing: no orphan immortality. Where tmux evidence
 * is absent (the legacy attach stack, until terminal phase 3 retires it)
 * `attachedClientIdleMs` is undefined and the decision is exactly v1's.
 *
 * Pure so the semantics are testable without a heartbeat file or a
 * process.exit.
 */

export const DEFAULT_IDLE_TTL_MS = 30 * 60_000;

export const DEFAULT_ATTACH_IDLE_TTL_MS = 4 * 60 * 60_000;

export interface LivenessInput {
  now: number;
  bootAt: number;
  clientCount: number;
  /** Parsed hook state, epochs in ms; undefined when absent or unparseable. */
  agentState: { state: string; at: number; busyUntil?: number } | undefined;
  lastClientInputAt: number;
  /** Epoch ms of the most recent attach connect (0 if none). */
  lastClientConnectAt: number;
  lastInjectionAt: number;
  /** Epoch ms of the most recent door-routed exec's stamp (0 if none). */
  lastDoorExecAt: number;
  /**
   * Minimum idle across LIVE tmux clients, ms — undefined when no client is
   * attached or the evidence source is not tmux (legacy attach stack), which
   * makes the connected-client rule vanish rather than fail open.
   */
  attachedClientIdleMs?: number;
  idleTtlMs: number;
  attachIdleTtlMs: number;
  busyStaleMs: number;
}

export function decideLiveness(input: LivenessInput): { alive: boolean; reason: string } {
  const {
    now,
    bootAt,
    clientCount,
    agentState,
    lastClientInputAt,
    lastClientConnectAt,
    lastInjectionAt,
    lastDoorExecAt,
    attachedClientIdleMs,
    idleTtlMs,
    attachIdleTtlMs,
    busyStaleMs,
  } = input;

  if (agentState?.state === 'busy') {
    // A wedged 'busy' (Esc fires no Stop hook) must not hold the lease
    // forever; past the cap its stamp still counts as plain activity below.
    if (now - agentState.at < busyStaleMs) {
      return { alive: true, reason: `agent busy for ${now - agentState.at}ms` };
    }
    // Inside a tool's declared window silence IS work: a 45-min test suite
    // fires no hook between PreToolUse and PostToolUse.
    if (agentState.busyUntil !== undefined && now < agentState.busyUntil) {
      return { alive: true, reason: `inside declared tool window (${agentState.busyUntil - now}ms left)` };
    }
  }

  // A live client with idle inside its own (longer) window holds the lease —
  // tmux vouches the client exists RIGHT NOW, so this can never outlive the
  // connection the way a high-water activity mark deliberately does.
  if (attachedClientIdleMs !== undefined && attachedClientIdleMs < attachIdleTtlMs) {
    return { alive: true, reason: `attached client idle ${attachedClientIdleMs}ms` };
  }

  const idleMs =
    now -
    Math.max(bootAt, agentState?.at ?? 0, lastClientInputAt, lastClientConnectAt, lastInjectionAt, lastDoorExecAt);
  if (idleMs < idleTtlMs) {
    const clients = clientCount > 0 ? `, ${clientCount} attach client(s)` : '';
    return { alive: true, reason: `last activity ${idleMs}ms ago${clients}` };
  }

  return { alive: false, reason: `agent not busy, idle ${idleMs}ms ≥ ttl ${idleTtlMs}ms (${clientCount} client(s))` };
}

/** NANOCLAW_CODE_IDLE_TTL_MS overrides the default; invalid or non-positive values are ignored. */
export function resolveIdleTtlMs(env: Record<string, string | undefined> = process.env): number {
  const parsed = parseInt(env.NANOCLAW_CODE_IDLE_TTL_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_IDLE_TTL_MS;
}

/** NANOCLAW_CODE_ATTACH_IDLE_TTL_MS overrides the default; invalid or non-positive values are ignored. */
export function resolveAttachIdleTtlMs(env: Record<string, string | undefined> = process.env): number {
  const parsed = parseInt(env.NANOCLAW_CODE_ATTACH_IDLE_TTL_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ATTACH_IDLE_TTL_MS;
}
