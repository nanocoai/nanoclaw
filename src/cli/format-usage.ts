/**
 * Aligned-table renderer for `ncl sessions usage` (human mode only).
 *
 * Server-rendered so the container client — which can't import host
 * formatters — prints the same table the host CLI does. The `--json` path is
 * untouched.
 */
import { TIMEZONE } from '../config.js';
import { formatLocalStamp } from '../timezone.js';

export interface UsageRow {
  session_id: string;
  agent_group_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_tokens: number;
  cost_usd: number;
  turns: number;
  updated_at: string;
}

export interface UsageReport {
  sessions: UsageRow[];
  totals: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    total_tokens: number;
    cost_usd: number;
    turns: number;
    sessions: number;
  };
  /** Sessions that banked nothing — not measured, which is not the same as free. */
  unreported: number;
}

/** One agent group, or one task series — the same numbers under a different key. */
export interface UsageGroupRow {
  key: string;
  sessions: number;
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

export interface UsageGroupReport {
  by: 'agent' | 'task';
  groups: UsageGroupRow[];
  totals: Omit<UsageGroupRow, 'key'>;
  /** Turns (or sessions, grouping by agent) the provider never measured. */
  unmeasured: number;
}

/** One turn: the prompt it answered and what it cost. Null means unmeasured. */
export interface PromptUsageRow {
  session_id: string;
  agent_group_id: string;
  timestamp: string;
  task_series_id: string | null;
  prompt_preview: string;
  prompt_chars: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
}

export interface PromptUsageReport {
  by: 'prompt';
  prompts: PromptUsageRow[];
  totals: {
    turns: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    total_tokens: number;
    cost_usd: number;
  };
  /** Listed turns the provider never measured — excluded from the totals. */
  unmeasured: number;
}

const COLS = ['SESSION', 'GROUP', 'TURNS', 'IN', 'OUT', 'CACHE R', 'CACHE W', 'TOTAL', 'COST'] as const;

/** Thousands separators — six-figure token counts are unreadable without them. */
function num(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * Two decimals is the natural unit for money, but a session that cost a
 * fraction of a cent would render as `$0.00` and look free. Widen instead.
 */
function money(value: number): string {
  return value > 0 && value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/** Column-aligned rows, header first and the total line last. */
function renderTable(cols: string[], body: string[][], total: string[]): string[] {
  const rows = [...body, total];
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((row) => row[i].length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return [line(cols), ...body.map(line), line(total)];
}

export function formatUsageTable(report: UsageReport): string {
  if (!report.sessions.length) {
    return report.unreported > 0
      ? `No usage recorded yet (${report.unreported} session(s) have reported nothing).`
      : 'No usage recorded yet.';
  }

  const body = report.sessions.map((r) => [
    r.session_id,
    r.agent_group_id,
    num(r.turns),
    num(r.input_tokens),
    num(r.output_tokens),
    num(r.cache_read_tokens),
    num(r.cache_creation_tokens),
    num(r.total_tokens),
    money(r.cost_usd),
  ]);
  const total = [
    'TOTAL',
    `${report.totals.sessions} session(s)`,
    num(report.totals.turns),
    num(report.totals.input_tokens),
    num(report.totals.output_tokens),
    num(report.totals.cache_read_tokens),
    num(report.totals.cache_creation_tokens),
    num(report.totals.total_tokens),
    money(report.totals.cost_usd),
  ];

  const out = renderTable([...COLS], body, total);
  if (report.unreported > 0) {
    // Named rather than folded into the table: an unmeasured session is a gap
    // in the accounting, not a session that cost nothing.
    out.push('', `${report.unreported} session(s) reported no usage (not counted above).`);
  }
  return out.join('\n');
}

export function formatGroupTable(report: UsageGroupReport): string {
  const keyCol = report.by === 'agent' ? 'AGENT GROUP' : 'TASK';
  if (!report.groups.length) return 'No usage recorded yet.';

  const cols = [keyCol, 'SESSIONS', 'TURNS', 'IN', 'OUT', 'CACHE R', 'CACHE W', 'TOTAL', 'COST'];
  const cells = (key: string, r: Omit<UsageGroupRow, 'key'>) => [
    key,
    num(r.sessions),
    num(r.turns),
    num(r.input_tokens),
    num(r.output_tokens),
    num(r.cache_read_tokens),
    num(r.cache_creation_tokens),
    num(r.total_tokens),
    money(r.cost_usd),
  ];

  const out = renderTable(
    cols,
    report.groups.map((g) => cells(g.key, g)),
    cells('TOTAL', report.totals),
  );
  if (report.unmeasured > 0) {
    out.push(
      '',
      `${report.unmeasured} unmeasured ${report.by === 'agent' ? 'session' : 'turn'}(s) (not counted above).`,
    );
  }
  return out.join('\n');
}

/** Prompts are long; the table shows enough to recognise the turn. */
const PROMPT_COL_CHARS = 60;

export function formatPromptTable(report: PromptUsageReport): string {
  if (!report.prompts.length) return 'No prompts recorded yet.';

  // A null is not a zero here, and must not read as one.
  const maybeNum = (value: number | null) => (value === null ? '—' : num(value));
  const maybeMoney = (value: number | null) => (value === null ? '—' : money(value));

  const cols = ['WHEN', 'SESSION', 'TASK', 'IN', 'OUT', 'CACHE', 'TOTAL', 'COST', 'PROMPT'];
  const body = report.prompts.map((p) => [
    formatLocalStamp(new Date(p.timestamp), TIMEZONE),
    p.session_id,
    p.task_series_id ?? '—',
    maybeNum(p.input_tokens),
    maybeNum(p.output_tokens),
    maybeNum(
      p.cache_read_tokens === null && p.cache_creation_tokens === null
        ? null
        : (p.cache_read_tokens ?? 0) + (p.cache_creation_tokens ?? 0),
    ),
    maybeNum(p.total_tokens),
    maybeMoney(p.cost_usd),
    p.prompt_preview.length > PROMPT_COL_CHARS
      ? `${p.prompt_preview.slice(0, PROMPT_COL_CHARS - 1)}…`
      : p.prompt_preview,
  ]);
  const total = [
    'TOTAL',
    `${report.totals.turns} turn(s)`,
    '',
    num(report.totals.input_tokens),
    num(report.totals.output_tokens),
    num(report.totals.cache_read_tokens + report.totals.cache_creation_tokens),
    num(report.totals.total_tokens),
    money(report.totals.cost_usd),
    '',
  ];

  const out = renderTable(cols, body, total);
  if (report.unmeasured > 0) {
    out.push('', `${report.unmeasured} of the turns above were never measured (shown as —, not counted).`);
  }
  return out.join('\n');
}
