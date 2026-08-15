/**
 * Aligned-table renderer for `ncl sessions usage` (human mode only).
 *
 * Server-rendered so the container client — which can't import host
 * formatters — prints the same table the host CLI does. The `--json` path is
 * untouched.
 */

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

  const rows = [...body, total];
  const widths = COLS.map((c, i) => Math.max(c.length, ...rows.map((row) => row[i].length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i]))
      .join('  ')
      .trimEnd();

  const out = [line([...COLS]), ...body.map(line), line(total)];
  if (report.unreported > 0) {
    // Named rather than folded into the table: an unmeasured session is a gap
    // in the accounting, not a session that cost nothing.
    out.push('', `${report.unreported} session(s) reported no usage (not counted above).`);
  }
  return out.join('\n');
}
