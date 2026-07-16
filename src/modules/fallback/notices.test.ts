import { describe, expect, it } from 'vitest';

import type { FallbackState } from './db.js';
import {
  commandDeniedNotice,
  doubleFaultNotice,
  forwardBriefing,
  noBackupNotice,
  returnBriefing,
  returnNotice,
  shortReturnBriefing,
  shortSwitchBriefing,
  statusNotice,
  switchAutoNotice,
  switchForcedNotice,
} from './notices.js';

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

describe('notices — pure text, no side effects', () => {
  it('switchAutoNotice mentions the backup provider and the classification reason', () => {
    const text = switchAutoNotice('quota', 'opencode', null);
    expect(text).toContain('opencode');
    expect(text).toContain('quota exhausted');
  });

  it('switchAutoNotice includes a formatted reset time when known', () => {
    const text = switchAutoNotice('overload', 'opencode', new Date('2026-01-01T10:00:00Z').toISOString());
    expect(text).toContain('Reset expected');
  });

  it('switchForcedNotice mentions the backup provider', () => {
    expect(switchForcedNotice('opencode')).toContain('opencode');
  });

  it('noBackupNotice explains there is no backup available', () => {
    const text = noBackupNotice('billing', null);
    expect(text).toContain('credit exhausted');
    expect(text).toContain('no backup model');
  });

  it('returnNotice and shortReturnBriefing are non-empty distinct strings', () => {
    expect(returnNotice().length).toBeGreaterThan(0);
    expect(shortReturnBriefing().length).toBeGreaterThan(0);
  });

  it('doubleFaultNotice and commandDeniedNotice are non-empty', () => {
    expect(doubleFaultNotice().length).toBeGreaterThan(0);
    expect(commandDeniedNotice().length).toBeGreaterThan(0);
  });

  it('forwardBriefing appends the summary only when provided', () => {
    const withoutSummary = forwardBriefing(null, 'opencode', null);
    const withSummary = forwardBriefing('user: ciao\nassistant: ciao a te', 'opencode', null);
    expect(withoutSummary).not.toContain('Summary');
    expect(withSummary).toContain('Summary');
    expect(withSummary).toContain('ciao a te');
  });

  it('returnBriefing appends the summary only when provided', () => {
    const withoutSummary = returnBriefing(null);
    const withSummary = returnBriefing('scambio precedente');
    expect(withoutSummary).not.toContain('summary');
    expect(withSummary).toContain('scambio precedente');
  });

  it('shortSwitchBriefing mentions the backup provider', () => {
    expect(shortSwitchBriefing('opencode', null)).toContain('opencode');
  });

  it('statusNotice reports inactive state plainly', () => {
    const text = statusNotice(baseState({ active: false }));
    expect(text).toContain('Fallback not active');
  });

  it('statusNotice reports auto mode with next-retry info', () => {
    const state = baseState({
      active: true,
      mode: 'auto',
      backupModel: null,
      backupProvider: 'opencode',
      classification: 'quota',
      enteredAt: new Date(0).toISOString(),
      nextRetryAt: new Date(60_000).toISOString(),
    });
    const text = statusNotice(state);
    expect(text).toContain('opencode');
    expect(text).toContain('automatic');
    expect(text).toContain('Next return attempt');
  });

  it('statusNotice reports forced mode without a next-retry line', () => {
    const state = baseState({
      active: true,
      mode: 'forced',
      backupModel: null,
      backupProvider: 'opencode',
      classification: 'manual',
    });
    const text = statusNotice(state);
    expect(text).toContain('forced');
    expect(text).toContain('/fallback return');
  });
});
