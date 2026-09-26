/**
 * Operational error sinks.
 *
 * The host's own plumbing failures — a startup crash loop, a scheduled task
 * whose pre-task script keeps failing, a message that could not be delivered —
 * are otherwise visible only in the host log. Core reports them here; a skill
 * registers a sink to forward them somewhere a human will see them.
 *
 * With no sink registered, reporting is a no-op. Reporting never throws and
 * never waits on a sink: a sink failure is logged and dropped.
 *
 * Keep this file dependency-free apart from log.js — the circuit breaker
 * reports through it before the DB or any channel exists.
 */
import { log } from './log.js';

export type OperationalErrorKind =
  | 'host.startup-backoff'
  | 'task.script-failing'
  | 'task.auto-paused'
  | 'delivery.failed';

export interface OperationalError {
  kind: OperationalErrorKind;
  /** One-line human summary. */
  message: string;
  /** Stable identity for deduplication, e.g. `task.script-failing:<series>`. */
  key: string;
  details?: Record<string, unknown>;
  timestamp: string;
}

export type OperationalErrorSink = (error: OperationalError) => void | Promise<void>;

const sinks: OperationalErrorSink[] = [];

/** Register a sink. Returns a function that unregisters it. */
export function registerOperationalErrorSink(sink: OperationalErrorSink): () => void {
  sinks.push(sink);
  return () => {
    const idx = sinks.indexOf(sink);
    if (idx !== -1) sinks.splice(idx, 1);
  };
}

export function reportOperationalError(error: Omit<OperationalError, 'timestamp'>): void {
  if (sinks.length === 0) return;
  const event: OperationalError = { ...error, timestamp: new Date().toISOString() };
  for (const sink of [...sinks]) {
    void Promise.resolve()
      .then(() => sink(event))
      .catch((err: unknown) => log.warn('Operational error sink failed', { kind: event.kind, err }));
  }
}
