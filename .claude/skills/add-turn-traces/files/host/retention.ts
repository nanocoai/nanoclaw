/**
 * Turn-trace retention. Traces can hold prompt and tool content, so they are
 * kept only for TURN_TRACE_RETENTION_DAYS (default 3). The first trace a host
 * process records prunes and starts an hourly prune; every `ncl traces` read
 * prunes first, so an expired trace is never shown.
 */
import { envValue } from '../../env.js';
import { log } from '../../log.js';
import { pruneTurnTraces } from './db.js';

export const DEFAULT_RETENTION_DAYS = 3;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

export function resolveRetentionDays(
  raw = process.env.TURN_TRACE_RETENTION_DAYS ?? envValue('TURN_TRACE_RETENTION_DAYS'),
): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_RETENTION_DAYS;
  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0) {
    log.warn('Invalid TURN_TRACE_RETENTION_DAYS, using default', { value: raw, days: DEFAULT_RETENTION_DAYS });
    return DEFAULT_RETENTION_DAYS;
  }
  return days;
}

export async function pruneExpiredTurnTraces(now = Date.now()): Promise<number> {
  const days = resolveRetentionDays();
  const removed = await pruneTurnTraces(new Date(now - days * DAY_MS).toISOString());
  if (removed > 0) log.info('Pruned expired turn traces', { removed, days });
  return removed;
}

async function pruneLogged(): Promise<void> {
  /* eslint-disable no-catch-all/no-catch-all -- a failed prune must not fail the delivery that triggered it; the next prune retries */
  try {
    await pruneExpiredTurnTraces();
  } catch (err) {
    log.warn('Turn trace prune failed', { err });
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

/** Start the hourly prune on first use; the first call also prunes now. Never throws. */
export async function ensureTurnTraceRetention(): Promise<void> {
  if (timer) return;
  timer = setInterval(() => void pruneLogged(), PRUNE_INTERVAL_MS);
  timer.unref();
  await pruneLogged();
}

export function stopTurnTraceRetention(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
