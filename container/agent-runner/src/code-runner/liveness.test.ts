/**
 * D14 liveness lease: each leg of decideLiveness (busy, declared tool
 * window, the v2 connected-client window, idle TTL with attach and door
 * evidence as plain activity), the busy-staleness cap, orphan-exec
 * immunity, boundary conditions, and the env-driven TTLs.
 */
import { describe, it, expect } from 'bun:test';

import {
  DEFAULT_ATTACH_IDLE_TTL_MS,
  DEFAULT_IDLE_TTL_MS,
  decideLiveness,
  resolveAttachIdleTtlMs,
  resolveIdleTtlMs,
  type LivenessInput,
} from './liveness.js';

const NOW = 10_000_000_000;
const TTL = 30 * 60_000;
const ATTACH_TTL = 4 * 60 * 60_000;

/** Everything stale by default — each test turns on exactly the leg it probes. */
function input(overrides: Partial<LivenessInput> = {}): LivenessInput {
  return {
    now: NOW,
    bootAt: NOW - TTL * 10,
    clientCount: 0,
    agentState: undefined,
    lastClientInputAt: 0,
    lastClientConnectAt: 0,
    lastInjectionAt: 0,
    lastDoorExecAt: 0,
    idleTtlMs: TTL,
    attachIdleTtlMs: ATTACH_TTL,
    busyStaleMs: TTL,
    ...overrides,
  };
}

describe('decideLiveness', () => {
  it('everything stale — the lease expires', () => {
    const decision = decideLiveness(input());
    expect(decision.alive).toBe(false);
    expect(decision.reason).toContain('idle');
  });

  it('a bare connected client is NOT a lease: an orphaned exec with stale input expires', () => {
    // docker/kubectl exec orphans survive a dead ssh forever — a socket
    // alone must never hold the pod (the immortality D14 closes). Note
    // attachedClientIdleMs stays undefined here: an attach-stack client
    // count is exactly the evidence tmux does NOT vouch for.
    expect(decideLiveness(input({ clientCount: 1 })).alive).toBe(false);
  });

  it('a LIVE tmux client inside the attach window holds the lease past the activity TTL', () => {
    // The acceptance case: attached-but-silent survives past 30 min — every
    // activity mark is stale, only the live client (idle 1h < 4h) holds.
    const decision = decideLiveness(input({ clientCount: 1, attachedClientIdleMs: 60 * 60_000 }));
    expect(decision.alive).toBe(true);
    expect(decision.reason).toBe(`attached client idle ${60 * 60_000}ms`);
  });

  it('attach window boundary is strict: a client idle exactly attachIdleTtlMs is not a lease', () => {
    expect(decideLiveness(input({ clientCount: 1, attachedClientIdleMs: ATTACH_TTL })).alive).toBe(false);
  });

  it('a vanished client contributes nothing — undefined idle falls through to the activity legs', () => {
    // The client detached (or its ssh died and tmux dropped it): with the
    // marks stale the pod expires — the connected-client lease never
    // outlives the connection that earned it.
    expect(decideLiveness(input({ attachedClientIdleMs: undefined })).alive).toBe(false);
  });

  it('the connected-client rule sits AFTER busy: a busy turn still answers with the busy reason', () => {
    const decision = decideLiveness(
      input({ agentState: { state: 'busy', at: NOW - 1000 }, clientCount: 1, attachedClientIdleMs: 0 }),
    );
    expect(decision.alive).toBe(true);
    expect(decision.reason).toContain('agent busy');
  });

  it('a recent client CONNECT holds the lease as activity', () => {
    expect(decideLiveness(input({ clientCount: 1, lastClientConnectAt: NOW - TTL + 1 })).alive).toBe(true);
  });

  it('a silently-watching client loses the lease at the TTL', () => {
    expect(
      decideLiveness(input({ clientCount: 1, lastClientConnectAt: NOW - TTL, lastClientInputAt: NOW - TTL })).alive,
    ).toBe(false);
  });

  it('a fresh busy turn holds the lease', () => {
    expect(decideLiveness(input({ agentState: { state: 'busy', at: NOW - TTL + 1 } })).alive).toBe(true);
  });

  it('busy staleness cap: a busy stamp exactly busyStaleMs old no longer holds via the busy leg', () => {
    // At the cap the busy leg is dead AND the stamp is too old for the idle
    // leg — a wedged turn (Esc, no Stop hook) cannot make the pod immortal.
    expect(decideLiveness(input({ agentState: { state: 'busy', at: NOW - TTL } })).alive).toBe(false);
  });

  it('a declared tool window extends busy past the staleness cap', () => {
    // 45-min test suite: stamp is past busyStaleMs but now < busyUntil.
    const decision = decideLiveness(
      input({ agentState: { state: 'busy', at: NOW - TTL, busyUntil: NOW + 15 * 60_000 } }),
    );
    expect(decision.alive).toBe(true);
    expect(decision.reason).toContain('declared tool window');
  });

  it('holds through a simulated permission-prompt window (Notification stamp), then expires at its cap', () => {
    // The Notification hook fires ONCE when the dialog appears and stamps
    // busy + busyUntil (mailbox-hook PERMISSION_PROMPT_HOLD_MS); no further
    // hook fires while the dialog waits. Deep into the wait — past the busy
    // staleness cap — the declared window is the only thing holding the pod.
    const promptAt = NOW - TTL - 60_000; // stamped 31 min ago, stale for the busy leg
    const hold = decideLiveness(
      input({ agentState: { state: 'busy', at: promptAt, busyUntil: NOW + 60_000 } }),
    );
    expect(hold.alive).toBe(true);
    expect(hold.reason).toContain('declared tool window');
    // The cap is the whole hold: one ms past busyUntil the prompt was going
    // nowhere and the pod expires — bounded, never immortality.
    const past = decideLiveness(
      input({
        agentState: { state: 'busy', at: NOW - TTL * 2, busyUntil: NOW - 1 },
        bootAt: NOW - TTL * 10,
      }),
    );
    expect(past.alive).toBe(false);
  });

  it('an expired tool window no longer holds the lease', () => {
    expect(
      decideLiveness(input({ agentState: { state: 'busy', at: NOW - TTL * 2, busyUntil: NOW - 1 } })).alive,
    ).toBe(false);
  });

  it('busyUntil on an idle state is ignored (only busy turns own a tool window)', () => {
    expect(
      decideLiveness(input({ agentState: { state: 'idle', at: NOW - TTL * 2, busyUntil: NOW + 60_000 } })).alive,
    ).toBe(false);
  });

  it('a stale busy stamp still counts as plain activity for the idle leg', () => {
    // busyStaleMs shorter than idleTtlMs: past the cap, within the TTL.
    const decision = decideLiveness(input({ busyStaleMs: 60_000, agentState: { state: 'busy', at: NOW - 120_000 } }));
    expect(decision.alive).toBe(true);
    expect(decision.reason).toContain('last activity');
  });

  it('an idle agent stamp within the TTL holds the lease', () => {
    expect(decideLiveness(input({ agentState: { state: 'idle', at: NOW - TTL + 1 } })).alive).toBe(true);
  });

  it('a recent boot holds the lease', () => {
    expect(decideLiveness(input({ bootAt: NOW - TTL + 1 })).alive).toBe(true);
  });

  it('recent client input holds the lease even after detach', () => {
    expect(decideLiveness(input({ lastClientInputAt: NOW - TTL + 1 })).alive).toBe(true);
  });

  it('a recent mailbox injection holds the lease', () => {
    expect(decideLiveness(input({ lastInjectionAt: NOW - TTL + 1 })).alive).toBe(true);
  });

  it('a recent door-routed exec holds the lease as plain activity', () => {
    // The 08-22 reaper, closed: a working day of door execs with no chat
    // traffic keeps the pod. Raw kubectl exec still stamps nothing.
    expect(decideLiveness(input({ lastDoorExecAt: NOW - TTL + 1 })).alive).toBe(true);
    expect(decideLiveness(input({ lastDoorExecAt: NOW - TTL })).alive).toBe(false);
  });

  it('idle boundary is strict: activity exactly idleTtlMs ago is expired', () => {
    expect(decideLiveness(input({ lastClientInputAt: NOW - TTL })).alive).toBe(false);
  });
});

describe('resolveIdleTtlMs', () => {
  it('defaults to 30 minutes when unset', () => {
    expect(resolveIdleTtlMs({})).toBe(DEFAULT_IDLE_TTL_MS);
    expect(DEFAULT_IDLE_TTL_MS).toBe(30 * 60_000);
  });

  it('honors a valid NANOCLAW_CODE_IDLE_TTL_MS', () => {
    expect(resolveIdleTtlMs({ NANOCLAW_CODE_IDLE_TTL_MS: '120000' })).toBe(120_000);
  });

  it('ignores invalid or non-positive values', () => {
    expect(resolveIdleTtlMs({ NANOCLAW_CODE_IDLE_TTL_MS: 'soon' })).toBe(DEFAULT_IDLE_TTL_MS);
    expect(resolveIdleTtlMs({ NANOCLAW_CODE_IDLE_TTL_MS: '-5' })).toBe(DEFAULT_IDLE_TTL_MS);
    expect(resolveIdleTtlMs({ NANOCLAW_CODE_IDLE_TTL_MS: '0' })).toBe(DEFAULT_IDLE_TTL_MS);
  });
});

describe('resolveAttachIdleTtlMs', () => {
  it('defaults to 4 hours when unset', () => {
    expect(resolveAttachIdleTtlMs({})).toBe(DEFAULT_ATTACH_IDLE_TTL_MS);
    expect(DEFAULT_ATTACH_IDLE_TTL_MS).toBe(4 * 60 * 60_000);
  });

  it('honors a valid NANOCLAW_CODE_ATTACH_IDLE_TTL_MS', () => {
    expect(resolveAttachIdleTtlMs({ NANOCLAW_CODE_ATTACH_IDLE_TTL_MS: '7200000' })).toBe(7_200_000);
  });

  it('ignores invalid or non-positive values', () => {
    expect(resolveAttachIdleTtlMs({ NANOCLAW_CODE_ATTACH_IDLE_TTL_MS: 'later' })).toBe(DEFAULT_ATTACH_IDLE_TTL_MS);
    expect(resolveAttachIdleTtlMs({ NANOCLAW_CODE_ATTACH_IDLE_TTL_MS: '-5' })).toBe(DEFAULT_ATTACH_IDLE_TTL_MS);
    expect(resolveAttachIdleTtlMs({ NANOCLAW_CODE_ATTACH_IDLE_TTL_MS: '0' })).toBe(DEFAULT_ATTACH_IDLE_TTL_MS);
  });
});
