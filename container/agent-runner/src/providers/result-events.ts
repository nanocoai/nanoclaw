/**
 * Provider result/compaction event-mapping seam — INERT by default.
 *
 * The provider translates two notable terminal SDK signals into ProviderEvents:
 *   - a `result` message (success carries `result`; an error subtype — e.g. a non-retryable
 *     403 billing_error / quota stop — leaves `result` undefined and puts the notice in
 *     `errors[]`), and
 *   - a `compact_boundary` system message (the SDK auto-compacted the context).
 *
 * Upstream's default mapping is `baseResultMessageEvents` / `baseCompactBoundaryEvent` below.
 * An install-overlay can REPLACE either mapping (e.g. to guarantee an error turn always carries
 * non-null text so the poll-loop never drops it, or to emit a `compacted` event the poll-loop
 * suppresses instead of a `result` it delivers). This is a presentation/UX seam, not a security
 * boundary — a single registered policy overrides (last registration wins); with none registered
 * the base defaults run, so default behaviour is identical to upstream.
 */
import type { ProviderEvent } from './types.js';

export interface ResultMessage {
  result?: string;
  is_error?: boolean;
  errors?: string[];
}

export interface CompactBoundaryMessage {
  compact_metadata?: { pre_tokens?: number };
}

/** Upstream default: success → `result??null`; error → result / joined errors[] / null. */
export function baseResultMessageEvents(message: ResultMessage): ProviderEvent[] {
  const text = message.result ?? (message.errors && message.errors.length > 0 ? message.errors.join('\n') : null);
  return [{ type: 'result', text, isError: message.is_error === true }];
}

/** Upstream default: the compaction notice is delivered to the user as a normal `result`. */
export function baseCompactBoundaryEvent(message: CompactBoundaryMessage): ProviderEvent {
  const detail = message.compact_metadata?.pre_tokens
    ? ` (${message.compact_metadata.pre_tokens.toLocaleString()} tokens compacted)`
    : '';
  return { type: 'result', text: `Context compacted${detail}.` };
}

export interface ProviderResultEventPolicy {
  /** Replace the `result`-message mapping. */
  mapResult?(message: ResultMessage): ProviderEvent[];
  /** Replace the `compact_boundary` mapping. */
  mapCompactBoundary?(message: CompactBoundaryMessage): ProviderEvent;
}

let policy: ProviderResultEventPolicy | null = null;

export function registerProviderResultEventPolicy(p: ProviderResultEventPolicy): void {
  // Single override (last wins). Mapping is one coherent decision, not a composition, so a
  // later registrant fully replaces an earlier one rather than chaining.
  policy = p;
}

export function mapResultMessage(message: ResultMessage): ProviderEvent[] {
  return policy?.mapResult ? policy.mapResult(message) : baseResultMessageEvents(message);
}

export function mapCompactBoundaryMessage(message: CompactBoundaryMessage): ProviderEvent {
  return policy?.mapCompactBoundary ? policy.mapCompactBoundary(message) : baseCompactBoundaryEvent(message);
}

/** Test-only: reset the registered policy. */
export function __resetProviderResultEventPolicyForTest(): void {
  policy = null;
}
