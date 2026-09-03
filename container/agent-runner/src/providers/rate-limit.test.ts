/**
 * Regression: the SDK's `rate_limit_event` is TELEMETRY ("emitted when rate
 * limit info changes"), not an error. We used to treat every one as terminal,
 * which logged a spurious quota error on healthy turns (#3016) and, in
 * consumers that act on the classification, aborted them outright (13 spurious
 * aborts across 6 rooms in one downstream install before this was caught).
 * Only status='rejected' is an actual block — and when it is,
 * the SDK tells us whether it's a transient window limit or genuinely no credits.
 */
import { describe, expect, it } from 'bun:test';
import { classifyRateLimitEvent } from './claude.js';

describe('classifyRateLimitEvent', () => {
  it('ignores informational events — the turn must not be disturbed', () => {
    expect(classifyRateLimitEvent({ status: 'allowed' })).toBeNull();
    expect(classifyRateLimitEvent({ status: 'allowed', utilization: 0.42, rateLimitType: 'five_hour' })).toBeNull();
    expect(classifyRateLimitEvent({ status: 'allowed_warning', utilization: 0.91 })).toBeNull();
    expect(classifyRateLimitEvent(undefined)).toBeNull();
    expect(classifyRateLimitEvent({})).toBeNull();
  });

  it('treats a rejected window limit as a transient rate limit, not billing', () => {
    const r = classifyRateLimitEvent({ status: 'rejected', rateLimitType: 'five_hour' });
    expect(r).not.toBeNull();
    expect(r!.classification).toBe('rate_limit');
    expect(r!.message).toContain('Rate limit');
    expect(r!.message).toContain('five_hour');
    expect(r!.message).not.toContain('Out of credits');
  });

  it('surfaces the reset time when the SDK provides one (seconds or ms)', () => {
    const secs = classifyRateLimitEvent({ status: 'rejected', resetsAt: 1_700_000_000 });
    const ms = classifyRateLimitEvent({ status: 'rejected', resetsAt: 1_700_000_000_000 });
    expect(secs!.message).toContain('resets');
    // both encodings must land on the same instant
    expect(secs!.message).toBe(ms!.message);
  });

  it('reports genuine credit exhaustion as a billing problem', () => {
    const byErrorCode = classifyRateLimitEvent({ status: 'rejected', errorCode: 'credits_required' });
    expect(byErrorCode!.classification).toBe('quota');
    expect(byErrorCode!.message).toContain('Out of credits');

    const byOverage = classifyRateLimitEvent({ status: 'rejected', overageDisabledReason: 'out_of_credits' });
    expect(byOverage!.classification).toBe('quota');
    expect(byOverage!.message).toContain('Out of credits');
  });
});
