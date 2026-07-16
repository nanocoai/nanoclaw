import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { bumpRetry, clearFallbackState, enterFallbackState, getFallbackState, setLastError, setProbe } from './db.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('fallback_state — seed row', () => {
  it('is seeded inactive by the migration', () => {
    const state = getFallbackState();
    expect(state.active).toBe(false);
    expect(state.mode).toBeNull();
    expect(state.backupProvider).toBeNull();
    expect(state.retryCount).toBe(0);
    expect(state.probing).toBe(false);
  });
});

describe('enterFallbackState', () => {
  it('activates the row and resets retry/probe bookkeeping', () => {
    const state = enterFallbackState({
      mode: 'auto',
      classification: 'quota',
      reason: 'quota exhausted',
      backupModel: null,
      backupProvider: 'opencode',
      resetAt: '2026-01-01T00:00:00.000Z',
      nextRetryAt: null,
      originSessionId: 'sess-1',
      originGroupId: 'group-1',
    });

    expect(state.active).toBe(true);
    expect(state.mode).toBe('auto');
    expect(state.classification).toBe('quota');
    expect(state.reason).toBe('quota exhausted');
    expect(state.backupProvider).toBe('opencode');
    expect(state.resetAt).toBe('2026-01-01T00:00:00.000Z');
    expect(state.retryCount).toBe(0);
    expect(state.probing).toBe(false);
    expect(state.originSessionId).toBe('sess-1');
    expect(state.originGroupId).toBe('group-1');
    expect(state.enteredAt).not.toBeNull();
  });

  it('clears any leftover probe/retry bookkeeping from a prior cycle', () => {
    enterFallbackState({
      mode: 'auto',
      classification: 'quota',
      reason: 'r1',
      backupModel: null,
      backupProvider: 'opencode',
      resetAt: null,
      nextRetryAt: null,
      originSessionId: 's1',
      originGroupId: 'g1',
    });
    setProbe({ probing: true, probeMessageId: 'm1', probeSessionId: 's1', probeStartedAt: new Date().toISOString() });
    bumpRetry(new Date(Date.now() + 60_000).toISOString());

    const state = enterFallbackState({
      mode: 'auto',
      classification: 'overload',
      reason: 'r2',
      backupModel: null,
      backupProvider: 'opencode',
      resetAt: null,
      nextRetryAt: null,
      originSessionId: 's2',
      originGroupId: 'g2',
    });

    expect(state.probing).toBe(false);
    expect(state.probeMessageId).toBeNull();
    expect(state.retryCount).toBe(0);
    expect(state.nextRetryAt).toBeNull();
  });
});

describe('clearFallbackState', () => {
  it('resets every field to its inactive defaults', () => {
    enterFallbackState({
      mode: 'forced',
      classification: 'manual',
      reason: 'r',
      backupModel: null,
      backupProvider: 'opencode',
      resetAt: null,
      nextRetryAt: null,
      originSessionId: 's1',
      originGroupId: 'g1',
    });
    setLastError('boom');

    const state = clearFallbackState();
    expect(state.active).toBe(false);
    expect(state.mode).toBeNull();
    expect(state.classification).toBeNull();
    expect(state.backupProvider).toBeNull();
    expect(state.originSessionId).toBeNull();
    expect(state.originGroupId).toBeNull();
    expect(state.lastError).toBeNull();
  });
});

describe('setProbe', () => {
  it('records probe bookkeeping without touching active/mode', () => {
    enterFallbackState({
      mode: 'auto',
      classification: 'quota',
      reason: 'r',
      backupModel: null,
      backupProvider: 'opencode',
      resetAt: null,
      nextRetryAt: null,
      originSessionId: 's1',
      originGroupId: 'g1',
    });

    const startedAt = new Date().toISOString();
    const state = setProbe({
      probing: true,
      probeMessageId: 'probe-1',
      probeSessionId: 's1',
      probeStartedAt: startedAt,
    });

    expect(state.active).toBe(true);
    expect(state.probing).toBe(true);
    expect(state.probeMessageId).toBe('probe-1');
    expect(state.probeSessionId).toBe('s1');
    expect(state.probeStartedAt).toBe(startedAt);
  });
});

describe('bumpRetry', () => {
  it('increments retry_count, sets next_retry_at, and clears probe fields', () => {
    enterFallbackState({
      mode: 'auto',
      classification: 'quota',
      reason: 'r',
      backupModel: null,
      backupProvider: 'opencode',
      resetAt: null,
      nextRetryAt: null,
      originSessionId: 's1',
      originGroupId: 'g1',
    });
    setProbe({
      probing: true,
      probeMessageId: 'probe-1',
      probeSessionId: 's1',
      probeStartedAt: new Date().toISOString(),
    });

    const nextRetry = new Date(Date.now() + 5 * 60_000).toISOString();
    const state = bumpRetry(nextRetry);

    expect(state.retryCount).toBe(1);
    expect(state.nextRetryAt).toBe(nextRetry);
    expect(state.probing).toBe(false);
    expect(state.probeMessageId).toBeNull();

    const state2 = bumpRetry(new Date(Date.now() + 10 * 60_000).toISOString());
    expect(state2.retryCount).toBe(2);
  });
});

describe('setLastError', () => {
  it('records the message without changing active/mode', () => {
    setLastError('generic provider error');
    const state = getFallbackState();
    expect(state.lastError).toBe('generic provider error');
    expect(state.active).toBe(false);
  });
});
