/**
 * Quota-exhaustion detection, shared by providers and the poll-loop's
 * fallback path. A "quota" error means the provider cannot serve any more
 * turns right now (subscription usage limit, hard rate limit, empty credit
 * balance) — as opposed to transient errors the SDK retries internally.
 */

// Applied ONLY to error messages / is_error result text — never to normal
// agent output — so loose terms like "rate limit" are safe here.
export const QUOTA_ERROR_RE =
  /usage limit reached|rate.?limit|quota|credit balance|insufficient credits|\b429\b|overloaded/i;

export function isQuotaErrorMessage(message: string): boolean {
  return QUOTA_ERROR_RE.test(message);
}

/**
 * Thrown by the poll-loop's event handling when the active provider reports
 * quota exhaustion mid-query. Carries the prompt segment that went
 * unanswered so the fallback provider can retry exactly that input.
 */
export class QuotaExhaustedError extends Error {
  constructor(
    message: string,
    readonly lastPrompt: string,
  ) {
    super(message);
    this.name = 'QuotaExhaustedError';
  }
}
