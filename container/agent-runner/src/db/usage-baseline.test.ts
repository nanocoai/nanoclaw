import { beforeEach, describe, expect, test } from 'bun:test';

import { getOutboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { turnUsage, usageDelta } from './usage-baseline.js';

beforeEach(() => {
  initTestSessionDb();
});

describe('usageDelta', () => {
  test('with no baseline the reading is the turn', () => {
    expect(usageDelta({ inputTokens: 120, outputTokens: 45, costUsd: 0.01 }, null)).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      costUsd: 0.01,
    });
  });

  test('subtracts the previous reading', () => {
    const delta = usageDelta(
      { inputTokens: 300, outputTokens: 90, cacheReadTokens: 12, cacheCreationTokens: 4, costUsd: 0.03 },
      { inputTokens: 120, outputTokens: 45, cacheReadTokens: 10, cacheCreationTokens: 4, costUsd: 0.01 },
    );

    expect(delta).toEqual({
      inputTokens: 180,
      outputTokens: 45,
      cacheReadTokens: 2,
      cacheCreationTokens: 0,
      costUsd: 0.02,
    });
  });

  test('a reading below the baseline is taken whole — the accumulator restarted', () => {
    expect(usageDelta({ inputTokens: 30, costUsd: 0.002 }, { inputTokens: 900, costUsd: 0.5 })).toEqual({
      inputTokens: 30,
      costUsd: 0.002,
    });
  });

  test('an unreported field stays unreported rather than becoming zero', () => {
    const delta = usageDelta({ inputTokens: 300 }, { inputTokens: 120, outputTokens: 45 });

    expect(delta).toEqual({ inputTokens: 180 });
    expect('outputTokens' in delta).toBe(false);
  });

  test('a field the baseline never saw is taken whole', () => {
    expect(usageDelta({ inputTokens: 300, cacheReadTokens: 7 }, { inputTokens: 120 })).toEqual({
      inputTokens: 180,
      cacheReadTokens: 7,
    });
  });

  test('cost subtraction does not leave float dust', () => {
    expect(usageDelta({ costUsd: 0.3 }, { costUsd: 0.1 }).costUsd).toBe(0.2);
  });

  test('a non-finite reading is dropped, not banked', () => {
    expect(usageDelta({ inputTokens: NaN, outputTokens: 45 }, null)).toEqual({ outputTokens: 45 });
  });
});

describe('turnUsage', () => {
  test('the first reading is banked whole, the second only its difference', () => {
    expect(turnUsage({ inputTokens: 120, costUsd: 0.01 }, 'sdk-1')).toEqual({ inputTokens: 120, costUsd: 0.01 });
    expect(turnUsage({ inputTokens: 300, costUsd: 0.03 }, 'sdk-1')).toEqual({ inputTokens: 180, costUsd: 0.02 });
    expect(turnUsage({ inputTokens: 340, costUsd: 0.04 }, 'sdk-1')).toEqual({ inputTokens: 40, costUsd: 0.01 });
  });

  test('a different session id starts from zero — readings are not comparable across accumulators', () => {
    turnUsage({ inputTokens: 900, costUsd: 0.5 }, 'sdk-1');

    expect(turnUsage({ inputTokens: 120, costUsd: 0.01 }, 'sdk-2')).toEqual({ inputTokens: 120, costUsd: 0.01 });
    expect(turnUsage({ inputTokens: 200, costUsd: 0.02 }, 'sdk-2')).toEqual({ inputTokens: 80, costUsd: 0.01 });
  });

  test('the baseline survives a restart — it lives in the mailbox, not in memory', () => {
    turnUsage({ inputTokens: 120, costUsd: 0.01 }, 'sdk-1');

    // A wake that resumes the same SDK session sees the restored totals again.
    expect(turnUsage({ inputTokens: 500, costUsd: 0.05 }, 'sdk-1')).toEqual({ inputTokens: 380, costUsd: 0.04 });
  });

  test('remembers a field the newest reading omits', () => {
    turnUsage({ inputTokens: 120, outputTokens: 45 }, 'sdk-1');
    turnUsage({ inputTokens: 200 }, 'sdk-1');

    expect(turnUsage({ inputTokens: 260, outputTokens: 70 }, 'sdk-1')).toEqual({ inputTokens: 60, outputTokens: 25 });
  });

  test('nothing to bank stays nothing — an unmeasured turn is not a free one', () => {
    expect(turnUsage(undefined, 'sdk-1')).toBeUndefined();
  });

  test('a corrupt baseline row is ignored rather than fatal', () => {
    getOutboundDb()
      .prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run('token_usage_baseline', '{not json', new Date().toISOString());

    expect(turnUsage({ inputTokens: 120 }, 'sdk-1')).toEqual({ inputTokens: 120 });
  });
});
