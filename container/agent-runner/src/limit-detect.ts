/**
 * Pure classification of provider signals that mean "Claude has hit a real
 * usage limit" (as opposed to a transient per-minute rate limit the SDK
 * already retries on its own). Used by providers/claude.ts to decide when
 * to surface a non-retryable limit error instead of a plain retryable one.
 */
export type LimitClassification = 'quota' | 'billing' | 'overload';

export interface LimitSignal {
  classification: LimitClassification;
  /** Epoch ms the limit is expected to reset, if known. */
  resetAt: number | null;
  message: string;
}

// Only 'rejected' means the request was actually blocked. SDK status is
// 'allowed' | 'allowed_warning' | 'rejected' — the first two mean the
// request went through and are not a fallback trigger (spec rule 2).
const BLOCKING_STATUSES = new Set(['rejected']);

/**
 * Classifies a `rate_limit_event`.rate_limit_info payload. Returns null
 * for anything that isn't an actual block (unknown/missing status, or
 * 'allowed'/'allowed_warning').
 */
export function classifyRateLimitEvent(raw: unknown): LimitSignal | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const status = typeof obj.status === 'string' ? obj.status.toLowerCase() : '';
  if (!BLOCKING_STATUSES.has(status)) return null;

  const resetsAtRaw = obj.resetsAt ?? obj.reset_at ?? obj.resetAt;
  const resetAt = typeof resetsAtRaw === 'number' && Number.isFinite(resetsAtRaw) ? resetsAtRaw * 1000 : null;

  const message = typeof obj.message === 'string' ? obj.message : `rate limit event: ${status}`;
  return { classification: 'quota', resetAt, message };
}

const BILLING_PATTERN = /billing|credit balance|insufficient credit|payment/i;

/** Classifies a `result` event's error text — billing/credit exhaustion doesn't resolve on its own. */
export function classifyErrorResultText(text: string): LimitSignal | null {
  if (!text) return null;
  if (BILLING_PATTERN.test(text)) {
    return { classification: 'billing', resetAt: null, message: text };
  }
  return null;
}

/**
 * A streak of consecutive `api_retry` system events with no successful
 * progress in between usually means the service is persistently overloaded
 * (the SDK's own retry loop can't get through). This is the primary
 * anti-block defense — it fires well before the 10-minute host backstop.
 */
export function classifyRetryStreak(streak: number, firstAtMs: number, nowMs: number): LimitSignal | null {
  const elapsedMs = nowMs - firstAtMs;
  if (streak >= 6 || elapsedMs > 5 * 60_000) {
    return {
      classification: 'overload',
      resetAt: null,
      message: `${streak} consecutive API retries over ${Math.round(elapsedMs / 1000)}s`,
    };
  }
  return null;
}
