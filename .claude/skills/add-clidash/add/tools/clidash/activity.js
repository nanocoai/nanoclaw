// Message-activity reader for clidash.
//
// ncl has no `messages` resource — message data lives in the per-session SQLite
// DBs (`data/v2-sessions/<group>/<session>/{inbound,outbound}.db`). We read them
// read-only with Node's built-in `node:sqlite` (no new dependency) and aggregate
// per-session in/out totals + a daily time-series for charting.

import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Timestamps come in two shapes across tables: SQLite "YYYY-MM-DD HH:MM:SS" (UTC)
// and already-ISO "YYYY-MM-DDTHH:MM:SS.sssZ". Normalize to a comparable ISO form
// so date-bucketing and max("last") work regardless of which a row used.
function normTs(ts) {
  if (typeof ts !== 'string' || ts.length < 10) return null;
  if (ts.includes('T')) return ts; // already ISO
  return `${ts.replace(' ', 'T')}Z`;
}

// Local calendar day "YYYY-MM-DD" — chart labels are read by a human, so
// bucket by the server's local day, not the UTC date prefix.
function localDay(date) {
  return date.toLocaleDateString('sv-SE');
}

function readTable(dbPath, table) {
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(`SELECT timestamp FROM ${table}`).all();
    const byDay = new Map();
    let last = null;
    for (const r of rows) {
      const ts = normTs(r.timestamp);
      if (!ts) continue;
      const day = localDay(new Date(ts));
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
      if (last === null || ts > last) last = ts;
    }
    return { total: rows.length, byDay, last };
  } catch {
    return { total: 0, byDay: new Map(), last: null }; // missing/locked/corrupt → skip
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

function listDirs(path) {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Aggregate message activity across all session DBs under `sessionsRoot`.
 * @returns {{ sessions: Array, series: Array<{date,in,out}> }}
 *   sessions — per session: { agent_group_id, session_id, in, out, lastActivity }
 *   series   — one bucket per day for the last `days` days (local time, newest last)
 */
export function collectActivity(sessionsRoot, days, now) {
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    dates.push(localDay(new Date(now.getTime() - i * 86_400_000)));
  }
  const series = new Map(dates.map((d) => [d, { date: d, in: 0, out: 0 }]));
  const sessions = [];

  for (const group of listDirs(sessionsRoot)) {
    for (const session of listDirs(join(sessionsRoot, group))) {
      const base = join(sessionsRoot, group, session);
      // a real session dir has at least one of the two message DBs; skip shared
      // scaffolding dirs like `.claude-shared` that don't.
      if (!existsSync(join(base, 'inbound.db')) && !existsSync(join(base, 'outbound.db'))) continue;
      const inb = readTable(join(base, 'inbound.db'), 'messages_in');
      const out = readTable(join(base, 'outbound.db'), 'messages_out');
      const lastActivity = [inb.last, out.last].filter(Boolean).sort().at(-1) ?? null;
      sessions.push({ agent_group_id: group, session_id: session, in: inb.total, out: out.total, lastActivity });
      for (const [day, n] of inb.byDay) series.get(day)?.in !== undefined && (series.get(day).in += n);
      for (const [day, n] of out.byDay) series.get(day)?.out !== undefined && (series.get(day).out += n);
    }
  }
  return { sessions, series: dates.map((d) => series.get(d)) };
}
