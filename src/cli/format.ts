/**
 * Output formatting for the `ncl` binary. Two modes:
 *   - human (default): a small auto-table for arrays of flat records,
 *     JSON.stringify for everything else, plain "error: ..." line for !ok.
 *   - json: the response frame, pretty-printed.
 *
 * The MCP / agent side will always pass --json so it parses the frame
 * itself. The DB transport (when it lands) skips this layer entirely —
 * the agent sees frames directly.
 */
import { TIMEZONE } from '../config.js';
import { formatLocalStamp } from '../timezone.js';
import type { ResponseFrame } from './frame.js';

export type FormatMode = 'human' | 'json';

// A string is treated as a display timestamp only when the WHOLE value is a
// UTC ISO instant; embedded occurrences inside longer strings may be machine
// payloads and stay raw. Mirrored in container/agent-runner/src/cli/ncl.ts
// (the two runtimes share no modules).
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;

/**
 * Human display shows local time; --json keeps the ISO machine contract.
 * The "YYYY-MM-DD HH:mm" stamp shape round-trips: parseZonedToUtc reads a
 * naive string as local wall-clock time, so a value copied from `ncl tasks
 * get` output into `--process-after` means what it shows.
 */
export function localizeIsoTimestamps(value: unknown): unknown {
  if (typeof value === 'string') {
    return ISO_UTC_RE.test(value) ? formatLocalStamp(new Date(value), TIMEZONE) : value;
  }
  if (Array.isArray(value)) return value.map(localizeIsoTimestamps);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, localizeIsoTimestamps(v)]),
    );
  }
  return value;
}

export function formatResponse(res: ResponseFrame, mode: FormatMode): string {
  if (mode === 'json') return JSON.stringify(res, null, 2) + '\n';

  if (!res.ok) {
    return `error (${res.error.code}): ${res.error.message}\n`;
  }
  return formatHuman(res.data) + '\n';
}

function formatHuman(rawData: unknown): string {
  const data = localizeIsoTimestamps(rawData);
  if (data === null || data === undefined) return '';
  if (typeof data === 'string') return data;
  if (Array.isArray(data) && data.every(isFlatRecord)) {
    return renderTable(data as Record<string, unknown>[]);
  }
  return JSON.stringify(data, null, 2);
}

function isFlatRecord(x: unknown): x is Record<string, unknown> {
  if (!x || typeof x !== 'object') return false;
  for (const v of Object.values(x as Record<string, unknown>)) {
    if (v !== null && typeof v === 'object') return false;
  }
  return true;
}

function renderTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '(no rows)';
  const cols = Object.keys(rows[0]);
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const fmtRow = (vals: string[]): string => vals.map((v, i) => v.padEnd(widths[i])).join('  ');
  const lines = [
    fmtRow(cols),
    fmtRow(widths.map((w) => '─'.repeat(w))),
    ...rows.map((r) => fmtRow(cols.map((c) => String(r[c] ?? '')))),
  ];
  return lines.join('\n');
}
