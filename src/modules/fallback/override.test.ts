import { describe, expect, it } from 'vitest';

import type { FallbackState } from './db.js';
import { effectiveProvider } from './override.js';

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

describe('effectiveProvider', () => {
  it('returns native when fallback is not active', () => {
    expect(effectiveProvider('claude', baseState({ active: false }))).toBe('claude');
  });

  it('returns the backup provider when fallback is active and not probing', () => {
    const state = baseState({ active: true, backupModel: null, backupProvider: 'opencode' });
    expect(effectiveProvider('claude', state)).toBe('opencode');
  });

  it('returns native during a return probe, even though fallback is still active', () => {
    const state = baseState({ active: true, backupModel: null, backupProvider: 'opencode', probing: true });
    expect(effectiveProvider('claude', state)).toBe('claude');
  });

  it('returns native when active but no backup provider is recorded', () => {
    const state = baseState({ active: true, backupModel: null, backupProvider: null });
    expect(effectiveProvider('claude', state)).toBe('claude');
  });

  it('is a no-op for a group whose native provider already equals the backup', () => {
    const state = baseState({ active: true, backupModel: null, backupProvider: 'opencode' });
    expect(effectiveProvider('opencode', state)).toBe('opencode');
  });
});
