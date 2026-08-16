/**
 * Per-turn usage ledger. Lives in outbound.db alongside the running totals in
 * `session_state`, and answers the question the totals cannot: which prompt
 * cost what.
 *
 * One row per provider turn — the prompt that was answered, the tokens and
 * cost it reported, and the task series it belonged to if it was a task run.
 * The agent group is deliberately absent: the host already knows which group
 * owns the session this file belongs to, and duplicating it here would let the
 * two disagree.
 *
 * Two deliberate limits:
 *
 * - The prompt is kept as a clipped preview, not in full. This is an
 *   accounting record, not a second copy of the conversation — enough to
 *   recognise a turn, not enough to be a transcript.
 * - The ledger keeps the last `TURN_LOG_RETENTION_DAYS` days and no longer. The
 *   totals in `session_state` are the authoritative lifetime figures; this
 *   table is the recent detail behind them.
 *
 * Retention is a timeframe rather than a row count on purpose. "What did this
 * cost last quarter" has to be answerable for a busy session and a quiet one
 * alike, and a row cap answers it for neither: it silently shortens the window
 * exactly when spend is high, and pins stale turns forever when it is low.
 */
import { getOutboundDb } from './connection.js';
import type { TokenUsageDelta } from './session-state.js';

/** How much of the prompt is kept. Enough to identify the turn on sight. */
export const PROMPT_PREVIEW_CHARS = 200;

/** How long a turn stays on the ledger. A quarter, so quarter-over-quarter
 *  comparisons are possible without the window moving under them. */
export const TURN_LOG_RETENTION_DAYS = 90;

export interface TurnRecord {
  /** The prompt this turn answered, as it was sent to the provider. */
  prompt: string;
  /** Task series this run belongs to, when the batch was a task run. */
  taskSeriesId?: string | null;
  /** Absent when the provider reported no usage at all. */
  usage?: TokenUsageDelta;
}

export interface TurnUsageRow {
  id: number;
  timestamp: string;
  task_series_id: string | null;
  prompt_preview: string;
  prompt_chars: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cost_usd: number | null;
}

/**
 * A number, or null. Unlike the running totals — where an unreported field
 * folds into a sum and has to become zero — a ledger row can say "not
 * reported" outright, and should.
 */
function measured(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** One line, clipped. A prompt is many lines of XML; a table row is one. */
function preview(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim().slice(0, PROMPT_PREVIEW_CHARS);
}

export function recordTurn(record: TurnRecord): void {
  const db = getOutboundDb();
  const usage = record.usage ?? {};
  db
    .prepare(
      `INSERT INTO token_usage_log
         (timestamp, task_series_id, prompt_preview, prompt_chars,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      new Date().toISOString(),
      record.taskSeriesId ?? null,
      preview(record.prompt),
      record.prompt.length,
      measured(usage.inputTokens),
      measured(usage.outputTokens),
      measured(usage.cacheReadTokens),
      measured(usage.cacheCreationTokens),
      measured(usage.costUsd),
    );

  // Age out on write. Timestamps are ISO-8601 UTC, so string order is
  // chronological order and the index makes this a range delete over the tail
  // rather than a scan.
  const cutoff = new Date(Date.now() - TURN_LOG_RETENTION_DAYS * 86_400_000).toISOString();
  db.prepare('DELETE FROM token_usage_log WHERE timestamp < ?').run(cutoff);
}

/** Most recent turns first. */
export function getTurnLog(limit = 100): TurnUsageRow[] {
  return getOutboundDb()
    .prepare('SELECT * FROM token_usage_log ORDER BY id DESC LIMIT ?')
    .all(limit) as TurnUsageRow[];
}
