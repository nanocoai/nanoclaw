import { beforeEach, describe, expect, test } from 'bun:test';

import { getOutboundDb, initTestSessionDb } from './connection.js';
import {
  addTokenUsage,
  clearContinuation,
  getContinuation,
  getTokenUsage,
  migrateLegacyContinuation,
  setContinuation,
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

describe('session-state — token usage', () => {
  test('no usage recorded yet reads as null', () => {
    expect(getTokenUsage()).toBeNull();
  });

  test('first turn establishes the totals', () => {
    addTokenUsage({ inputTokens: 12, outputTokens: 34, cacheReadTokens: 5, cacheCreationTokens: 6, costUsd: 0.25 });

    expect(getTokenUsage()).toMatchObject({
      input_tokens: 12,
      output_tokens: 34,
      cache_read_tokens: 5,
      cache_creation_tokens: 6,
      cost_usd: 0.25,
      turns: 1,
    });
  });

  test('subsequent turns accumulate', () => {
    addTokenUsage({ inputTokens: 10, outputTokens: 1, costUsd: 0.1 });
    addTokenUsage({ inputTokens: 5, outputTokens: 2, costUsd: 0.2 });

    const totals = getTokenUsage();
    expect(totals?.input_tokens).toBe(15);
    expect(totals?.output_tokens).toBe(3);
    expect(totals?.turns).toBe(2);
    // Float addition must not leak 0.30000000000000004 into the CLI output.
    expect(totals?.cost_usd).toBe(0.3);
  });

  test('omitted fields count as zero rather than NaN', () => {
    addTokenUsage({ inputTokens: 7, outputTokens: 8 });

    expect(getTokenUsage()).toMatchObject({
      input_tokens: 7,
      output_tokens: 8,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cost_usd: 0,
      turns: 1,
    });
  });

  test('a garbled provider payload cannot poison the running total', () => {
    addTokenUsage({ inputTokens: 10, outputTokens: 10, costUsd: 0.5 });
    addTokenUsage({
      inputTokens: Number.NaN,
      outputTokens: -5,
      costUsd: Number.POSITIVE_INFINITY,
    });

    const totals = getTokenUsage();
    expect(totals?.input_tokens).toBe(10);
    expect(totals?.output_tokens).toBe(10);
    expect(totals?.cost_usd).toBe(0.5);
    // The turn still happened, even if its numbers were unusable.
    expect(totals?.turns).toBe(2);
  });

  test('stamps updated_at so the host can tell a live session from a stale one', () => {
    addTokenUsage({ inputTokens: 1, outputTokens: 1 });

    expect(getTokenUsage()?.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  test('a corrupt row reads as null and the next turn starts a fresh total', () => {
    getOutboundDb()
      .prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run('token_usage', 'not json', new Date().toISOString());

    expect(getTokenUsage()).toBeNull();

    addTokenUsage({ inputTokens: 3, outputTokens: 4 });
    expect(getTokenUsage()).toMatchObject({ input_tokens: 3, output_tokens: 4, turns: 1 });
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
