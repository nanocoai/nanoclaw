import { writeMessageOut } from './db/messages-out.js';
import type { LimitClassification } from './limit-detect.js';

function generateId(): string {
  return `sys-fallback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Thrown from processQuery when a provider signals a real usage limit
 * (quota/billing/overload — not a transient per-minute rate limit). Caught
 * by runPollLoop, which reports it to the host instead of surfacing a plain
 * `Error:` chat message.
 */
export class ProviderLimitError extends Error {
  constructor(
    public readonly signal: { classification: LimitClassification; resetAt: number | null; message: string },
    public readonly provider: string,
  ) {
    super(signal.message);
    this.name = 'ProviderLimitError';
  }
}

export interface FallbackReport {
  classification: LimitClassification;
  resetAt: number | null;
  message: string;
  provider: string;
  /** Ids of the messages that were in flight when the limit hit — left `processing` for the host to re-present. */
  messageIds: string[];
}

/**
 * Reports a hit limit to the host via a `kind:'system'` outbound row (the
 * `registerDeliveryAction` pattern — see src/delivery.ts and
 * src/modules/fallback/index.ts, which registers the `fallback_report`
 * handler).
 */
export function writeFallbackReport(report: FallbackReport): void {
  writeMessageOut({
    id: generateId(),
    kind: 'system',
    content: JSON.stringify({ action: 'fallback_report', ...report }),
  });
}
