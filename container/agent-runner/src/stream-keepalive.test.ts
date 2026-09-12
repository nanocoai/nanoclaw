/**
 * Stream keep-alive policy tests: off-by-default parsing, the 60s floor, and
 * the bounded vouching window that preserves the hung-provider backstop
 * (#2668) while keeping slow decodes (#3643) alive.
 */
import { describe, expect, it } from 'bun:test';

import { MIN_STREAM_KEEPALIVE_MS, parseStreamKeepAliveMs, shouldKeepAliveTouch } from './stream-keepalive.js';

describe('parseStreamKeepAliveMs', () => {
  it('is off (undefined) when unset, empty, or invalid', () => {
    expect(parseStreamKeepAliveMs(undefined)).toBeUndefined();
    expect(parseStreamKeepAliveMs(null)).toBeUndefined();
    expect(parseStreamKeepAliveMs('')).toBeUndefined();
    expect(parseStreamKeepAliveMs('ninety minutes')).toBeUndefined();
    expect(parseStreamKeepAliveMs('1.5')).toBeUndefined();
    expect(parseStreamKeepAliveMs('0')).toBeUndefined();
    expect(parseStreamKeepAliveMs('-1')).toBeUndefined();
    expect(parseStreamKeepAliveMs(String(MIN_STREAM_KEEPALIVE_MS - 1))).toBeUndefined();
    expect(parseStreamKeepAliveMs('Infinity')).toBeUndefined();
  });

  it('accepts integer ms at or above the 60s floor', () => {
    expect(parseStreamKeepAliveMs(String(MIN_STREAM_KEEPALIVE_MS))).toBe(MIN_STREAM_KEEPALIVE_MS);
    expect(parseStreamKeepAliveMs('5400000')).toBe(5_400_000);
    expect(parseStreamKeepAliveMs(' 5400000 ')).toBe(5_400_000);
  });
});

describe('shouldKeepAliveTouch', () => {
  const T0 = 1_000_000_000;

  it('never touches when keep-alive is off', () => {
    expect(shouldKeepAliveTouch(T0, T0, undefined)).toBe(false);
  });

  it('touches while the last provider event is younger than the cap', () => {
    const cap = 90 * 60 * 1000;
    expect(shouldKeepAliveTouch(T0 + 1, T0, cap)).toBe(true);
    expect(shouldKeepAliveTouch(T0 + cap - 1, T0, cap)).toBe(true);
  });

  it('stops vouching once the stream has been silent past the cap — the ceiling backstop survives', () => {
    const cap = 90 * 60 * 1000;
    expect(shouldKeepAliveTouch(T0 + cap, T0, cap)).toBe(false);
    expect(shouldKeepAliveTouch(T0 + cap + 1, T0, cap)).toBe(false);
  });

  it('a fresh provider event reopens the window', () => {
    const cap = 90 * 60 * 1000;
    const silentPast = T0 + cap + 60_000;
    expect(shouldKeepAliveTouch(silentPast, T0, cap)).toBe(false);
    // Event lands at silentPast: lastEvent moves forward, vouching resumes.
    expect(shouldKeepAliveTouch(silentPast + 1, silentPast, cap)).toBe(true);
  });
});
