import { describe, expect, it } from 'bun:test';

import { classifyErrorResultText, classifyRateLimitEvent, classifyRetryStreak } from './limit-detect.js';

describe('classifyRateLimitEvent', () => {
  it('returns null for non-object input', () => {
    expect(classifyRateLimitEvent(null)).toBeNull();
    expect(classifyRateLimitEvent(undefined)).toBeNull();
    expect(classifyRateLimitEvent('rejected')).toBeNull();
  });

  it('returns null for an allowed or allowed_warning status (spec rule 2 — stays on the retry path)', () => {
    expect(classifyRateLimitEvent({ status: 'allowed' })).toBeNull();
    expect(classifyRateLimitEvent({ status: 'allowed_warning' })).toBeNull();
  });

  it('returns null for an unknown or missing status', () => {
    expect(classifyRateLimitEvent({})).toBeNull();
    expect(classifyRateLimitEvent({ status: 'ok' })).toBeNull();
  });

  it('classifies a rejected status as quota with no resetAt when absent', () => {
    const signal = classifyRateLimitEvent({ status: 'rejected' });
    expect(signal).not.toBeNull();
    expect(signal?.classification).toBe('quota');
    expect(signal?.resetAt).toBeNull();
  });

  it('classifies a rejected status as quota and converts resetsAt seconds to ms', () => {
    const signal = classifyRateLimitEvent({ status: 'rejected', resetsAt: 1_700_000_000 });
    expect(signal?.classification).toBe('quota');
    expect(signal?.resetAt).toBe(1_700_000_000 * 1000);
  });

  it('accepts snake_case and camelCase reset field aliases', () => {
    expect(classifyRateLimitEvent({ status: 'rejected', reset_at: 100 })?.resetAt).toBe(100_000);
    expect(classifyRateLimitEvent({ status: 'rejected', resetAt: 200 })?.resetAt).toBe(200_000);
  });

  it('is case-insensitive on status', () => {
    expect(classifyRateLimitEvent({ status: 'REJECTED' })?.classification).toBe('quota');
  });

  it('falls back to a generated message when none is provided', () => {
    const signal = classifyRateLimitEvent({ status: 'rejected' });
    expect(signal?.message).toContain('rejected');
  });

  it('uses the provided message when present', () => {
    const signal = classifyRateLimitEvent({ status: 'rejected', message: 'custom text' });
    expect(signal?.message).toBe('custom text');
  });
});

describe('classifyErrorResultText', () => {
  it('returns null for empty text', () => {
    expect(classifyErrorResultText('')).toBeNull();
  });

  it('returns null for text with no billing signal', () => {
    expect(classifyErrorResultText('some unrelated error')).toBeNull();
  });

  it('classifies billing-pattern text as billing with no resetAt', () => {
    const signal = classifyErrorResultText('Your credit balance is too low');
    expect(signal).not.toBeNull();
    expect(signal?.classification).toBe('billing');
    expect(signal?.resetAt).toBeNull();
    expect(signal?.message).toBe('Your credit balance is too low');
  });

  it('matches on insufficient credit and payment phrasing too', () => {
    expect(classifyErrorResultText('insufficient credit to continue')?.classification).toBe('billing');
    expect(classifyErrorResultText('payment required')?.classification).toBe('billing');
  });

  it('is case-insensitive', () => {
    expect(classifyErrorResultText('BILLING ISSUE')?.classification).toBe('billing');
  });
});

describe('classifyRetryStreak', () => {
  it('returns null below both the streak-count and elapsed-time thresholds', () => {
    const now = 1_000_000;
    expect(classifyRetryStreak(3, now, now + 60_000)).toBeNull();
  });

  it('classifies as overload once the streak reaches 6', () => {
    const now = 1_000_000;
    const signal = classifyRetryStreak(6, now, now + 10_000);
    expect(signal?.classification).toBe('overload');
    expect(signal?.resetAt).toBeNull();
  });

  it('classifies as overload once 5 minutes have elapsed, regardless of streak count', () => {
    const now = 1_000_000;
    const signal = classifyRetryStreak(2, now, now + 5 * 60_000 + 1);
    expect(signal?.classification).toBe('overload');
  });

  it('does not fire at exactly 5 minutes elapsed (strict greater-than)', () => {
    const now = 1_000_000;
    expect(classifyRetryStreak(2, now, now + 5 * 60_000)).toBeNull();
  });

  it('includes the streak count and elapsed seconds in the message', () => {
    const now = 1_000_000;
    const signal = classifyRetryStreak(6, now, now + 12_000);
    expect(signal?.message).toContain('6');
    expect(signal?.message).toContain('12s');
  });
});
