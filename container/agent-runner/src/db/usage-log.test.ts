import { describe, expect, it, beforeEach, afterEach } from 'bun:test';

import { closeSessionDb, getOutboundDb, initTestSessionDb } from './connection.js';
import { getTurnLog, PROMPT_PREVIEW_CHARS, recordTurn, TURN_LOG_RETENTION_DAYS } from './usage-log.js';

/** A turn stamped in the past — `recordTurn` always stamps "now". */
function seedTurnAt(timestamp: string, prompt: string): void {
  getOutboundDb()
    .prepare(
      `INSERT INTO token_usage_log (timestamp, task_series_id, prompt_preview, prompt_chars, input_tokens)
       VALUES (?, NULL, ?, ?, 1)`,
    )
    .run(timestamp, prompt, prompt.length);
}

describe('usage-log', () => {
  beforeEach(() => {
    initTestSessionDb();
  });

  afterEach(() => {
    closeSessionDb();
  });

  it('records one row per turn with its prompt and what it cost', () => {
    recordTurn({
      prompt: '<message from="dilpreet">how much have we spent</message>',
      usage: {
        inputTokens: 120,
        outputTokens: 45,
        cacheReadTokens: 8000,
        cacheCreationTokens: 900,
        costUsd: 0.0321,
      },
    });

    const rows = getTurnLog();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      prompt_preview: '<message from="dilpreet">how much have we spent</message>',
      input_tokens: 120,
      output_tokens: 45,
      cache_read_tokens: 8000,
      cache_creation_tokens: 900,
      cost_usd: 0.0321,
      task_series_id: null,
    });
    expect(rows[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('clips the preview but records how long the prompt really was', () => {
    // The ledger is an accounting record, not a transcript — it keeps enough
    // of the prompt to recognise the turn and nothing more.
    const prompt = 'x'.repeat(PROMPT_PREVIEW_CHARS + 500);
    recordTurn({ prompt, usage: { inputTokens: 1 } });

    const [row] = getTurnLog();
    expect(row.prompt_preview).toHaveLength(PROMPT_PREVIEW_CHARS);
    expect(row.prompt_chars).toBe(PROMPT_PREVIEW_CHARS + 500);
  });

  it('collapses whitespace so a multi-line prompt stays one readable line', () => {
    recordTurn({ prompt: '  <message>\n\n  first\tsecond  \n</message>  ', usage: { inputTokens: 1 } });

    expect(getTurnLog()[0].prompt_preview).toBe('<message> first second </message>');
  });

  it('keeps the prompt of an unmeasured turn, with null numbers rather than zeros', () => {
    // A provider that reports nothing still ran the turn. Zeros would claim it
    // was free; null says it was never measured.
    recordTurn({ prompt: 'unmeasured turn' });

    const [row] = getTurnLog();
    expect(row.prompt_preview).toBe('unmeasured turn');
    expect(row.input_tokens).toBeNull();
    expect(row.output_tokens).toBeNull();
    expect(row.cost_usd).toBeNull();
  });

  it('leaves an individually absent field null while keeping the reported ones', () => {
    recordTurn({ prompt: 'partial', usage: { inputTokens: 10, outputTokens: 5 } });

    const [row] = getTurnLog();
    expect(row.input_tokens).toBe(10);
    expect(row.cache_read_tokens).toBeNull();
    expect(row.cost_usd).toBeNull();
  });

  it('drops a value that is not a usable number rather than coercing it', () => {
    recordTurn({
      prompt: 'garbled',
      usage: { inputTokens: Number.NaN, outputTokens: -3, costUsd: 0.5 },
    });

    const [row] = getTurnLog();
    expect(row.input_tokens).toBeNull();
    expect(row.output_tokens).toBeNull();
    expect(row.cost_usd).toBe(0.5);
  });

  it('stamps the task series so a run can be costed on its own', () => {
    recordTurn({ prompt: 'daily briefing', taskSeriesId: 'daily-briefing-a25c', usage: { inputTokens: 7 } });

    expect(getTurnLog()[0].task_series_id).toBe('daily-briefing-a25c');
  });

  it('returns newest first, and honours a limit', () => {
    recordTurn({ prompt: 'first', usage: { inputTokens: 1 } });
    recordTurn({ prompt: 'second', usage: { inputTokens: 2 } });
    recordTurn({ prompt: 'third', usage: { inputTokens: 3 } });

    expect(getTurnLog().map((r) => r.prompt_preview)).toEqual(['third', 'second', 'first']);
    expect(getTurnLog(2).map((r) => r.prompt_preview)).toEqual(['third', 'second']);
  });

  it('drops turns that fall outside the retention window', () => {
    // Retention is a timeframe, not a row count: "what did we spend last
    // quarter" has to stay answerable for a busy session and a quiet one alike.
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    seedTurnAt(daysAgo(TURN_LOG_RETENTION_DAYS + 1), 'too old');
    seedTurnAt(daysAgo(TURN_LOG_RETENTION_DAYS - 1), 'just inside');

    recordTurn({ prompt: 'today', usage: { inputTokens: 1 } });

    expect(getTurnLog().map((r) => r.prompt_preview)).toEqual(['today', 'just inside']);
  });

  it('keeps every turn inside the window, however many there are', () => {
    // No row cap: a busy day must not silently evict the rest of the window.
    for (let i = 0; i < 500; i++) recordTurn({ prompt: `turn ${i}`, usage: { inputTokens: 1 } });

    const rows = getTurnLog(1000);
    expect(rows).toHaveLength(500);
    expect(rows[rows.length - 1].prompt_preview).toBe('turn 0');
  });
});
