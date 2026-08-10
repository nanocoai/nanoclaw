import { beforeEach, describe, expect, test } from 'bun:test';

import { getOutboundDb, initTestSessionDb } from './connection.js';
import {
  clearCurrentTurnContext,
  clearContinuation,
  getContinuation,
  getCurrentTurnContext,
  migrateLegacyContinuation,
  setContinuation,
  setCurrentTurnContext,
} from './session-state.js';

beforeEach(() => {
  initTestSessionDb();
});

function seedLegacy(value: string): void {
  getOutboundDb()
    .prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('sdk_session_id', value, new Date().toISOString());
}

describe('session-state — per-provider continuations', () => {
  test('set/get round-trip, case-insensitive provider key', () => {
    setContinuation('claude', 'claude-conv-1');
    expect(getContinuation('claude')).toBe('claude-conv-1');
    expect(getContinuation('Claude')).toBe('claude-conv-1');
    expect(getContinuation('CLAUDE')).toBe('claude-conv-1');
  });

  test('providers are isolated — switching reads the right slot', () => {
    setContinuation('claude', 'claude-conv-1');
    setContinuation('codex', 'codex-thread-xyz');

    expect(getContinuation('claude')).toBe('claude-conv-1');
    expect(getContinuation('codex')).toBe('codex-thread-xyz');
  });

  test('clearContinuation only affects the specified provider', () => {
    setContinuation('claude', 'keep-me');
    setContinuation('codex', 'drop-me');

    clearContinuation('codex');

    expect(getContinuation('claude')).toBe('keep-me');
    expect(getContinuation('codex')).toBeUndefined();
  });

  test('unknown provider returns undefined', () => {
    expect(getContinuation('never-used')).toBeUndefined();
  });
});

describe('session-state — legacy migration', () => {
  test('adopts legacy value into current provider when current is empty', () => {
    seedLegacy('old-session-id');

    const adopted = migrateLegacyContinuation('claude');

    expect(adopted).toBe('old-session-id');
    expect(getContinuation('claude')).toBe('old-session-id');
  });

  test('always deletes legacy row regardless of migration outcome', () => {
    seedLegacy('old-session-id');
    setContinuation('claude', 'existing');

    migrateLegacyContinuation('claude');

    // After migration the legacy key must be gone, whether or not it was adopted.
    // A subsequent migration for a different provider must not see it.
    const resultAfterSecondCall = migrateLegacyContinuation('codex');
    expect(resultAfterSecondCall).toBeUndefined();
  });

  test('prefers existing current-provider slot over legacy', () => {
    seedLegacy('legacy-value');
    setContinuation('claude', 'claude-value');

    const result = migrateLegacyContinuation('claude');

    expect(result).toBe('claude-value');
    expect(getContinuation('claude')).toBe('claude-value');
  });

  test('no legacy row — returns current provider value (possibly undefined)', () => {
    expect(migrateLegacyContinuation('claude')).toBeUndefined();

    setContinuation('codex', 'codex-value');
    expect(migrateLegacyContinuation('codex')).toBe('codex-value');
  });

  test('migration is idempotent on a second call (legacy already gone)', () => {
    seedLegacy('once');

    const first = migrateLegacyContinuation('claude');
    expect(first).toBe('once');

    const second = migrateLegacyContinuation('claude');
    expect(second).toBe('once');
  });
});

describe('session-state — active turn context', () => {
  test('round-trips and clears turn identity with its reply stamp', () => {
    setCurrentTurnContext('turn-1', 'inbound-1');
    expect(getCurrentTurnContext()).toEqual({ turnId: 'turn-1', inReplyTo: 'inbound-1' });

    clearCurrentTurnContext();
    expect(getCurrentTurnContext()).toBeNull();
  });

  test('supports turns without an a2a reply stamp', () => {
    setCurrentTurnContext('turn-1', null);
    expect(getCurrentTurnContext()).toEqual({ turnId: 'turn-1', inReplyTo: null });
  });

  test('covers long tool runs but ignores crash-stale context', () => {
    setCurrentTurnContext('turn-1', 'inbound-1');
    getOutboundDb()
      .prepare("UPDATE session_state SET updated_at = ? WHERE key = 'current_turn_context'")
      .run(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());
    expect(getCurrentTurnContext()?.turnId).toBe('turn-1');

    getOutboundDb()
      .prepare("UPDATE session_state SET updated_at = ? WHERE key = 'current_turn_context'")
      .run(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());
    expect(getCurrentTurnContext()).toBeNull();
  });
});
