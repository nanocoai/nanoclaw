import { beforeEach, describe, expect, test } from 'bun:test';

import { initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { turnUsageFromResult, usageFromResult } from './claude.js';

// The SDK's result message is the only place per-turn token counts appear.
// Nothing downstream re-derives them, so anything dropped here is gone.

function success(extra: Record<string, unknown>) {
  return { type: 'result', subtype: 'success', is_error: false, result: 'hi', ...extra };
}

describe('usageFromResult', () => {
  test('reads the token counts and cost off a successful turn', () => {
    expect(
      usageFromResult(
        success({
          usage: {
            input_tokens: 120,
            output_tokens: 45,
            cache_creation_input_tokens: 900,
            cache_read_input_tokens: 8000,
          },
          total_cost_usd: 0.0321,
        }),
      ),
    ).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      cacheCreationTokens: 900,
      cacheReadTokens: 8000,
      costUsd: 0.0321,
    });
  });

  test('an errored turn still burned tokens and still reports them', () => {
    expect(
      usageFromResult({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        usage: { input_tokens: 10, output_tokens: 0 },
        total_cost_usd: 0.001,
      }),
    ).toMatchObject({ inputTokens: 10, outputTokens: 0, costUsd: 0.001 });
  });

  test('cache fields are optional — a turn without them is still usage', () => {
    expect(usageFromResult(success({ usage: { input_tokens: 5, output_tokens: 6 } }))).toEqual({
      inputTokens: 5,
      outputTokens: 6,
      cacheCreationTokens: undefined,
      cacheReadTokens: undefined,
      costUsd: undefined,
    });
  });

  test('a result with no usage block reports nothing rather than zeros', () => {
    // Zeros would read as "this turn was free", which is a different claim
    // from "this provider did not tell us".
    expect(usageFromResult(success({}))).toBeUndefined();
  });

  test('non-numeric fields are dropped, not coerced', () => {
    expect(
      usageFromResult(success({ usage: { input_tokens: '120', output_tokens: 45 }, total_cost_usd: null })),
    ).toEqual({
      inputTokens: undefined,
      outputTokens: 45,
      cacheCreationTokens: undefined,
      cacheReadTokens: undefined,
      costUsd: undefined,
    });
  });

  test('a non-result message is not usage', () => {
    expect(usageFromResult({ type: 'system', subtype: 'init' })).toBeUndefined();
    expect(usageFromResult(null)).toBeUndefined();
    expect(usageFromResult('result')).toBeUndefined();
  });

  test('a usage block with nothing usable in it reports nothing', () => {
    // An object of undefineds is truthy, and every caller tests truthiness
    // before banking. A turn banked from one counts as measured and free.
    expect(usageFromResult(success({ usage: {} }))).toBeUndefined();
    expect(usageFromResult(success({ usage: { input_tokens: null }, total_cost_usd: '0.02' }))).toBeUndefined();
  });
});

describe('turnUsageFromResult', () => {
  beforeEach(() => {
    initTestSessionDb();
  });

  // The SDK's counters run for the whole session, not the turn. One query()
  // outlives a turn — the poll loop pushes follow-ups and nudges into the open
  // stream and each push yields its own result — so consecutive readings share
  // everything spent before them.
  function result(sessionId: string, inputTokens: number, costUsd: number) {
    return success({ session_id: sessionId, usage: { input_tokens: inputTokens }, total_cost_usd: costUsd });
  }

  test('bills each turn for its own tokens, not the session running total', () => {
    expect(turnUsageFromResult(result('sdk-1', 120, 0.01))).toMatchObject({ inputTokens: 120, costUsd: 0.01 });
    expect(turnUsageFromResult(result('sdk-1', 300, 0.03))).toMatchObject({ inputTokens: 180, costUsd: 0.02 });
    expect(turnUsageFromResult(result('sdk-1', 340, 0.04))).toMatchObject({ inputTokens: 40, costUsd: 0.01 });
  });

  test('a resumed session does not re-bill everything it ever spent', () => {
    // On resume the SDK restores the previous run's totals, so the first result
    // after a wake already contains the whole history. Only what is new is new.
    turnUsageFromResult(result('sdk-1', 120, 0.01));

    expect(turnUsageFromResult(result('sdk-1', 500, 0.05))).toMatchObject({ inputTokens: 380, costUsd: 0.04 });
  });

  test('a different SDK session starts its own count', () => {
    turnUsageFromResult(result('sdk-1', 900, 0.5));

    expect(turnUsageFromResult(result('sdk-2', 120, 0.01))).toMatchObject({ inputTokens: 120, costUsd: 0.01 });
  });

  test('an unmeasured turn stays unmeasured', () => {
    expect(turnUsageFromResult(success({ session_id: 'sdk-1' }))).toBeUndefined();
  });
});
