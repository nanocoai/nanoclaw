/**
 * Quota-exhaustion detection, shared by providers and the poll-loop's
 * fallback path.
 *
 * There are TWO distinct signal classes and conflating them was the source
 * of a production false-positive (2026-07-06): a transient 429 right after a
 * container restart was misread as usage-exhaustion and tripped the Codex
 * fallback while real usage was only ~63% of the session window.
 *
 *   GENUINE   — the subscription / credit is actually spent; the provider
 *               cannot serve another turn until it resets. This is the ONLY
 *               class that may trip the fallback and notify the user.
 *   TRANSIENT — the server is briefly throttling or overloaded (HTTP 429/529,
 *               "overloaded", "temporarily limiting requests"). The Claude
 *               SDK already retries these internally; we must NOT switch
 *               providers and must NOT notify.
 */

// Genuine, durable exhaustion. Anthropic subscription limits surface either
// as the literal "…usage limit reached|<resetEpoch>" error, or — confirmed
// live 2026-07-06 — as a *successful* result whose text is the session-limit
// banner ("You've hit your session limit · resets 7:30am (UTC)"). The credit
// / quota phrases cover the API-key billing case. None of these appear in an
// ordinary agent reply, and (critically) NOT a bare 429 / rate-limit / overload.
export const GENUINE_QUOTA_RE =
  /usage limit reached|hit your session limit|session limit[^\n]*reset|reached your usage limit|credit balance (is )?too low|insufficient credits|quota (exceeded|exhausted|has been used)/i;

// Transient throttling / overload — explicitly NOT a genuine exhaustion.
// Retried by the SDK; surfaced here only so callers can positively recognise
// a "wait and retry" condition versus a "switch providers" one.
export const TRANSIENT_LIMIT_RE =
  /\b429\b|\b529\b|rate.?limit|overloaded|temporarily (limiting|unavailable)|server (is )?(busy|overloaded)|please try again/i;

/**
 * True only for a genuine, durable usage/credit exhaustion — the sole
 * condition that may trip the Codex fallback + user notification.
 */
export function isGenuineQuotaError(message: string): boolean {
  return GENUINE_QUOTA_RE.test(message);
}

/**
 * True for a transient throttle/overload that is NOT a genuine exhaustion.
 * Genuine wording always wins, so a message that is both (e.g. a limit error
 * that happens to include "429") is treated as genuine, not transient.
 */
export function isTransientLimit(message: string): boolean {
  return !GENUINE_QUOTA_RE.test(message) && TRANSIENT_LIMIT_RE.test(message);
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
