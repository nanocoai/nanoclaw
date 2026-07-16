import { describe, expect, it } from 'vitest';

import type { FallbackState } from './db.js';
import { decideFallbackSweep, nextRetryAt, RESPONSE_GUARANTEE_MS, RETURN_BACKOFF_MIN } from './decide.js';

function baseState(overrides: Partial<FallbackState> = {}): FallbackState {
  return {
    active: false,
    mode: null,
    classification: null,
    reason: null,
    backupModel: null,
    backupProvider: null,
    enteredAt: null,
    resetAt: null,
    nextRetryAt: null,
    retryCount: 0,
    probing: false,
    probeMessageId: null,
    probeSessionId: null,
    probeStartedAt: null,
    originSessionId: null,
    originGroupId: null,
    lastError: null,
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe('nextRetryAt', () => {
  it('walks the backoff schedule by retry count', () => {
    const now = 1_000_000;
    for (let i = 0; i < RETURN_BACKOFF_MIN.length; i++) {
      expect(nextRetryAt(i, now)).toBe(now + RETURN_BACKOFF_MIN[i] * 60_000);
    }
  });

  it('caps at the last backoff entry beyond the schedule length', () => {
    const now = 1_000_000;
    const last = RETURN_BACKOFF_MIN[RETURN_BACKOFF_MIN.length - 1];
    expect(nextRetryAt(RETURN_BACKOFF_MIN.length + 5, now)).toBe(now + last * 60_000);
  });
});

describe('decideFallbackSweep — forced mode', () => {
  it('never probes, regardless of resetAt/nextRetryAt', () => {
    const state = baseState({ active: true, mode: 'forced', resetAt: new Date(0).toISOString() });
    const decision = decideFallbackSweep({
      nowMs: Date.now(),
      state,
      probeRowStatus: null,
      overdueTriggerMessages: [],
    });
    expect(decision).toEqual({ type: 'none' });
  });
});

describe('decideFallbackSweep — auto mode, not probing', () => {
  it('starts a probe once resetAt has passed', () => {
    const state = baseState({ active: true, mode: 'auto', resetAt: new Date(1000).toISOString() });
    const decision = decideFallbackSweep({
      nowMs: 2000,
      state,
      probeRowStatus: null,
      overdueTriggerMessages: [],
    });
    expect(decision).toEqual({ type: 'start-probe' });
  });

  it('starts a probe once nextRetryAt has passed when resetAt is unknown', () => {
    const state = baseState({ active: true, mode: 'auto', resetAt: null, nextRetryAt: new Date(1000).toISOString() });
    const decision = decideFallbackSweep({
      nowMs: 2000,
      state,
      probeRowStatus: null,
      overdueTriggerMessages: [],
    });
    expect(decision).toEqual({ type: 'start-probe' });
  });

  it('does nothing before the due time', () => {
    const state = baseState({ active: true, mode: 'auto', resetAt: new Date(5000).toISOString() });
    const decision = decideFallbackSweep({
      nowMs: 2000,
      state,
      probeRowStatus: null,
      overdueTriggerMessages: [],
    });
    expect(decision).toEqual({ type: 'none' });
  });

  it('does nothing when neither resetAt nor nextRetryAt is set', () => {
    const state = baseState({ active: true, mode: 'auto' });
    const decision = decideFallbackSweep({
      nowMs: Date.now(),
      state,
      probeRowStatus: null,
      overdueTriggerMessages: [],
    });
    expect(decision).toEqual({ type: 'none' });
  });
});

describe('decideFallbackSweep — auto mode, probing', () => {
  it('reports probe-success when the probe row completed', () => {
    const state = baseState({ active: true, mode: 'auto', probing: true, probeStartedAt: new Date(0).toISOString() });
    const decision = decideFallbackSweep({
      nowMs: 1000,
      state,
      probeRowStatus: 'completed',
      overdueTriggerMessages: [],
    });
    expect(decision).toEqual({ type: 'probe-success' });
  });

  it('reports probe-timeout after 10 minutes without completion', () => {
    const startedAt = 0;
    const state = baseState({
      active: true,
      mode: 'auto',
      probing: true,
      probeStartedAt: new Date(startedAt).toISOString(),
    });
    const decision = decideFallbackSweep({
      nowMs: startedAt + 10 * 60_000 + 1,
      state,
      probeRowStatus: 'pending',
      overdueTriggerMessages: [],
    });
    expect(decision).toEqual({ type: 'probe-timeout' });
  });

  it('does nothing while still within the probe window', () => {
    const startedAt = 0;
    const state = baseState({
      active: true,
      mode: 'auto',
      probing: true,
      probeStartedAt: new Date(startedAt).toISOString(),
    });
    const decision = decideFallbackSweep({
      nowMs: startedAt + 60_000,
      state,
      probeRowStatus: 'pending',
      overdueTriggerMessages: [],
    });
    expect(decision).toEqual({ type: 'none' });
  });

  it('prefers probe-success over an elapsed timeout window', () => {
    const startedAt = 0;
    const state = baseState({
      active: true,
      mode: 'auto',
      probing: true,
      probeStartedAt: new Date(startedAt).toISOString(),
    });
    const decision = decideFallbackSweep({
      nowMs: startedAt + 20 * 60_000,
      state,
      probeRowStatus: 'completed',
      overdueTriggerMessages: [],
    });
    expect(decision).toEqual({ type: 'probe-success' });
  });
});

describe('decideFallbackSweep — not active, response guarantee', () => {
  it('reports guarantee-breach for messages older than the 10-minute window', () => {
    const state = baseState({ active: false });
    const decision = decideFallbackSweep({
      nowMs: Date.now(),
      state,
      probeRowStatus: null,
      overdueTriggerMessages: [
        { id: 'm1', ageMs: RESPONSE_GUARANTEE_MS + 1 },
        { id: 'm2', ageMs: RESPONSE_GUARANTEE_MS - 1 },
      ],
    });
    expect(decision).toEqual({ type: 'guarantee-breach', messageIds: ['m1'] });
  });

  it('extends the threshold for a declared long-running Bash call', () => {
    const state = baseState({ active: false });
    const declaredBashMs = 20 * 60_000;
    const decision = decideFallbackSweep({
      nowMs: Date.now(),
      state,
      probeRowStatus: null,
      overdueTriggerMessages: [{ id: 'm1', ageMs: RESPONSE_GUARANTEE_MS + 1 }],
      declaredBashMs,
    });
    // Below the extended threshold (declaredBashMs + 60s) — not a breach.
    expect(decision).toEqual({ type: 'none' });
  });

  it('returns none when no message is overdue', () => {
    const state = baseState({ active: false });
    const decision = decideFallbackSweep({
      nowMs: Date.now(),
      state,
      probeRowStatus: null,
      overdueTriggerMessages: [],
    });
    expect(decision).toEqual({ type: 'none' });
  });
});
