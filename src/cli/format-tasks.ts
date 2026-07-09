/**
 * Compact aligned-table renderer for `ncl tasks list` (human mode only).
 *
 * A task series is a recurring job; each fire is a run. This surfaces the run history
 * the raw row hides — run count, last/next fire, schedule — as an aligned table.
 * Driven by the enriched rows from listTasks (tasks.ts); the --json path is
 * untouched. `now` is injectable so the relative times are testable.
 */

interface TaskListRow {
  series_id: string;
  schedule?: string | null;
  runs?: number;
  failed_runs?: number;
  last_run?: string | null;
  next_run?: string | null;
  status?: string;
  log?: string | null;
  created_at?: string | null;
  prompt?: string | null;
}

const COLS = ['SERIES', 'SCHEDULE', 'RUNS', 'FAILED', 'LAST RUN', 'NEXT RUN', 'STATUS', 'AGE', 'PROMPT'] as const;

function parseMs(iso: string): number {
  return Date.parse(/[Z+]|[+-]\d\d:\d\d$/.test(iso) ? iso : iso + 'Z');
}

/** "1m ago" / "in 30s" — coarse, human relative time. */
function duration(ms: number): string {
  const s = Math.abs(ms) / 1000;
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function lastRun(iso: string | null | undefined, now: number): string {
  if (!iso) return '-';
  const t = parseMs(iso);
  if (Number.isNaN(t)) return iso;
  return `${duration(now - t)} ago`;
}

function nextRun(iso: string | null | undefined, now: number): string {
  if (!iso) return '-';
  const t = parseMs(iso);
  if (Number.isNaN(t)) return iso;
  return t <= now ? 'due' : `in ${duration(t - now)}`;
}

/** AGE — how long since the series was created. */
function age(iso: string | null | undefined, now: number): string {
  if (!iso) return '-';
  const t = parseMs(iso);
  return Number.isNaN(t) ? '-' : duration(now - t);
}

function clip(s: string | null | undefined, n: number): string {
  const v = (s ?? '').replace(/\s+/g, ' ').trim();
  return v.length > n ? v.slice(0, n - 1) + '…' : v;
}

export function formatTasksTable(rows: TaskListRow[], now: number = Date.now()): string {
  if (!rows.length) return 'No tasks.';
  const body = rows.map((r) => [
    r.series_id, // full id, copy-pasteable into `ncl tasks get --id <…>`
    r.schedule || 'once',
    String(r.runs ?? 0),
    String(r.failed_runs ?? 0),
    lastRun(r.last_run, now),
    nextRun(r.next_run, now),
    r.status ?? '-',
    age(r.created_at, now),
    clip(r.prompt, 40),
  ]);
  const widths = COLS.map((c, i) => Math.max(c.length, ...body.map((row) => row[i].length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return [line([...COLS]), ...body.map(line)].join('\n');
}
