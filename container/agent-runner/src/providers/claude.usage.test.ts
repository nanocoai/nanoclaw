import { describe, expect, test } from 'bun:test';

import { usageFromResult } from './claude.js';

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
});
