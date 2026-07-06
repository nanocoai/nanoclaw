/**
 * Quota-exhaustion detection, shared by providers and the poll-loop's
 * fallback path. A "quota" error means the provider cannot serve any more
 * turns right now (subscription usage limit, hard rate limit, empty credit
 * balance) — as opposed to transient errors the SDK retries internally.
 */

// Checked against ANY result text, not just is_error results — confirmed in
// production (2026-07-06, daniela's server) that a subscription session-limit
// hit comes back as the literal *successful* result text ("You've hit your
// session limit · resets 7:30am (UTC)"), not as an SDK-level error. A normal
// agent reply is exceedingly unlikely to contain these phrases by accident.
export const QUOTA_ERROR_RE =
  /usage limit reached|hit your session limit|session limit.*reset|rate.?limit|quota|credit balance|insufficient credits|\b429\b|overloaded/i;

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
