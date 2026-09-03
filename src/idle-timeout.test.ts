/**
 * Validation tests for the configurable idle timeout (#3643):
 * NANOCLAW_IDLE_TIMEOUT_MS → built-in 30-minute default, with an invalid
 * value falling back to the default instead of breaking the sweep.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_IDLE_TIMEOUT_MS,
  MAX_IDLE_TIMEOUT_MS,
  MIN_IDLE_TIMEOUT_MS,
  parseIdleTimeoutMs,
  resolveIdleTimeoutMs,
} from './idle-timeout.js';

describe('parseIdleTimeoutMs', () => {
  it('accepts integer ms inside the allowed range, from number or string', () => {
    expect(parseIdleTimeoutMs(MIN_IDLE_TIMEOUT_MS)).toBe(MIN_IDLE_TIMEOUT_MS);
    expect(parseIdleTimeoutMs(MAX_IDLE_TIMEOUT_MS)).toBe(MAX_IDLE_TIMEOUT_MS);
    expect(parseIdleTimeoutMs(3_600_000)).toBe(3_600_000);
    expect(parseIdleTimeoutMs('3600000')).toBe(3_600_000);
    expect(parseIdleTimeoutMs(' 3600000 ')).toBe(3_600_000);
    expect(parseIdleTimeoutMs('1e7')).toBe(10_000_000); // scientific notation is still an integer
  });

  it('refuses a floor below the sweep interval plus the claim tolerance', () => {
    // The sweep ticks every 60s and tolerates a claim for 60s, so anything
    // under 2 min can kill a healthy container on its first quiet tick.
    expect(MIN_IDLE_TIMEOUT_MS).toBe(2 * 60 * 1000);
    expect(parseIdleTimeoutMs(60_000)).toBeUndefined();
    expect(parseIdleTimeoutMs('119999')).toBeUndefined();
  });

  it('refuses a value so large it would disable stuck detection', () => {
    // Regression: an unbounded check let '1e21' through, leaving a hung
    // container holding its session and claim forever.
    expect(parseIdleTimeoutMs(MAX_IDLE_TIMEOUT_MS + 1)).toBeUndefined();
    expect(parseIdleTimeoutMs('1e21')).toBeUndefined();
    expect(parseIdleTimeoutMs(Number.MAX_SAFE_INTEGER)).toBeUndefined();
    expect(parseIdleTimeoutMs('9007199254740993')).toBeUndefined(); // precision loss
  });

  it('rejects unset, empty, non-numeric, and fractional values', () => {
    expect(parseIdleTimeoutMs(undefined)).toBeUndefined();
    expect(parseIdleTimeoutMs(null)).toBeUndefined();
    expect(parseIdleTimeoutMs('')).toBeUndefined();
    expect(parseIdleTimeoutMs('30 minutes')).toBeUndefined();
    expect(parseIdleTimeoutMs(1.5)).toBeUndefined();
    expect(parseIdleTimeoutMs(0)).toBeUndefined();
    expect(parseIdleTimeoutMs(-1)).toBeUndefined();
    expect(parseIdleTimeoutMs(MIN_IDLE_TIMEOUT_MS - 1)).toBeUndefined();
    expect(parseIdleTimeoutMs(NaN)).toBeUndefined();
    expect(parseIdleTimeoutMs(Infinity)).toBeUndefined();
  });
});

describe('resolveIdleTimeoutMs', () => {
  it('defaults to 30 minutes when the env var is unset or empty', () => {
    expect(resolveIdleTimeoutMs(undefined)).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    expect(resolveIdleTimeoutMs('')).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });

  it('uses the env override when it is set', () => {
    expect(resolveIdleTimeoutMs('5400000')).toBe(5_400_000);
  });

  it('falls back to the default when the env override is invalid', () => {
    expect(resolveIdleTimeoutMs('soon')).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    expect(resolveIdleTimeoutMs('-5')).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    expect(resolveIdleTimeoutMs(String(MIN_IDLE_TIMEOUT_MS - 1))).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    expect(resolveIdleTimeoutMs(String(MAX_IDLE_TIMEOUT_MS + 1))).toBe(DEFAULT_IDLE_TIMEOUT_MS);
  });
});
