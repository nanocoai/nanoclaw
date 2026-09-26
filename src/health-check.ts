/**
 * `ncl health` (#2504) — a local, read-only operational health check.
 *
 * Deliberately does not go through `dispatch()`/the ncl socket transport:
 * every other `ncl` command requires a live host process to serve the
 * socket, but the whole point of a health check is to still say something
 * useful when that process is down. This module reads the same on-disk
 * state a live host reads (central DB opened read-only, the error log
 * stderr is redirected to) directly, with no dependency on anything being
 * up. See `src/cli/client.ts` for the early-return that routes here before
 * a transport is ever picked.
 */
import fs from 'fs';
import path from 'path';

import { CENTRAL_DB_PATH } from './config.js';
import { closeDb, initDb, getDb } from './db/connection.js';
import { listLiveHostInstances } from './db/coordination.js';

const DEFAULT_ERROR_WINDOW_MS = 60 * 60 * 1000; // 1 hour, per #2504's ask
// OneCLI credential-approval TTLs are minutes-scale (see onecli-approvals.ts),
// so "nearing expiry" is a short horizon, not the 1-hour error window above.
const DEFAULT_EXPIRING_WITHIN_MS = 15 * 60 * 1000;
// No log rotation exists yet (checked: no logrotate config, no in-repo
// rotation code), so nanoclaw.error.log grows unbounded across a long-lived
// process. Tail instead of reading the whole file so this stays cheap on an
// old install with a multi-hundred-MB log.
const MAX_LOG_TAIL_BYTES = 1_000_000;

export interface HostInstanceSummary {
  instanceId: string;
  hostname: string | null;
  pid: number | null;
  startedAt: string;
  uptimeSeconds: number;
}

export interface HostLiveness {
  running: boolean;
  instances: HostInstanceSummary[];
}

export interface SessionSummary {
  id: string;
  agentGroupId: string;
  agentGroupName: string | null;
  status: string;
  containerStatus: string;
  lastActive: string | null;
  createdAt: string;
}

export interface LogEntry {
  /** Best-effort — the log line itself carries no date, only HH:MM:SS.mmm; see resolveTimestamp. */
  timestamp: string;
  level: string;
  message: string;
}

export interface ExpiringApproval {
  approvalId: string;
  action: string;
  title: string;
  expiresAt: string;
  secondsRemaining: number;
}

export interface HealthReport {
  generatedAt: string;
  host: HostLiveness;
  sessions: SessionSummary[];
  recentErrors: LogEntry[];
  expiringApprovals: ExpiringApproval[];
  /** Things this report could not check, and why — e.g. no DB, no log file. */
  notes: string[];
}

export interface CollectHealthReportOptions {
  now?: Date;
  errorWindowMs?: number;
  expiringWithinMs?: number;
  logPath?: string;
  dbPath?: string;
}

export async function collectHealthReport(opts: CollectHealthReportOptions = {}): Promise<HealthReport> {
  const now = opts.now ?? new Date();
  const dbPath = opts.dbPath ?? CENTRAL_DB_PATH;
  const notes: string[] = [];

  let host: HostLiveness = { running: false, instances: [] };
  let sessions: SessionSummary[] = [];
  let expiringApprovals: ExpiringApproval[] = [];

  if (!fs.existsSync(dbPath)) {
    notes.push(`central database not found at ${dbPath} — this install has never started`);
  } else {
    await initDb(dbPath, { role: 'tool', readonly: true });
    try {
      host = await collectHostLiveness(now);
      sessions = await collectSessionSummaries();
      expiringApprovals = await collectExpiringApprovals(now, opts.expiringWithinMs ?? DEFAULT_EXPIRING_WITHIN_MS);
    } finally {
      await closeDb();
    }
  }

  const logPath = opts.logPath ?? path.join(process.cwd(), 'logs', 'nanoclaw.error.log');
  const tail = readRecentErrors(logPath, now, opts.errorWindowMs ?? DEFAULT_ERROR_WINDOW_MS);
  if (tail.missingFile) {
    notes.push(
      `no error log found at ${logPath} — either nothing has logged a warning/error yet, or the process manager isn't redirecting stderr there (see docs/quickstart.md)`,
    );
  }

  return {
    generatedAt: now.toISOString(),
    host,
    sessions,
    recentErrors: tail.entries,
    expiringApprovals,
    notes,
  };
}

async function collectHostLiveness(now: Date): Promise<HostLiveness> {
  const rows = await listLiveHostInstances(now.toISOString());
  return {
    running: rows.length > 0,
    instances: rows.map((r) => ({
      instanceId: r.instance_id,
      hostname: r.hostname,
      pid: r.pid,
      startedAt: r.started_at,
      uptimeSeconds: Math.max(0, Math.round((now.getTime() - new Date(r.started_at).getTime()) / 1000)),
    })),
  };
}

interface SessionRow {
  id: string;
  agentGroupId: string;
  agentGroupName: string | null;
  status: string;
  containerStatus: string;
  lastActive: string | null;
  createdAt: string;
}

async function collectSessionSummaries(): Promise<SessionSummary[]> {
  return getDb().all<SessionRow>(`
    SELECT
      s.id                 AS id,
      s.agent_group_id     AS agentGroupId,
      g.name                AS agentGroupName,
      s.status              AS status,
      s.container_status    AS containerStatus,
      s.last_active          AS lastActive,
      s.created_at           AS createdAt
    FROM sessions s
    LEFT JOIN agent_groups g ON g.id = s.agent_group_id
    ORDER BY s.last_active DESC
  `);
}

interface ApprovalRow {
  approval_id: string;
  action: string;
  title: string;
  expires_at: string;
}

async function collectExpiringApprovals(now: Date, withinMs: number): Promise<ExpiringApproval[]> {
  const cutoff = new Date(now.getTime() + withinMs).toISOString();
  const rows = await getDb().all<ApprovalRow>(
    `SELECT approval_id, action, title, expires_at FROM pending_approvals
     WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?
     ORDER BY expires_at ASC`,
    cutoff,
  );
  return rows.map((r) => ({
    approvalId: r.approval_id,
    action: r.action,
    title: r.title,
    expiresAt: r.expires_at,
    secondsRemaining: Math.max(0, Math.round((new Date(r.expires_at).getTime() - now.getTime()) / 1000)),
  }));
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
// src/log.ts's emit(): `[HH:MM:SS.mmm] LEVEL message key=value ...`
const LINE_RE = /^\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})\]\s+([A-Z]+)\s+(.*)$/;
const RELEVANT_LEVELS = new Set(['WARN', 'ERROR', 'FATAL']);

function readRecentErrors(
  logPath: string,
  now: Date,
  windowMs: number,
): { missingFile: boolean; entries: LogEntry[] } {
  if (!fs.existsSync(logPath)) return { missingFile: true, entries: [] };

  const cutoff = now.getTime() - windowMs;
  const entries: LogEntry[] = [];
  for (const rawLine of readTail(logPath, MAX_LOG_TAIL_BYTES).split('\n')) {
    const line = rawLine.replace(ANSI_RE, '');
    if (!line) continue;
    const m = line.match(LINE_RE);
    if (!m) continue;
    const [, hh, mm, ss, ms, level] = m;
    if (!RELEVANT_LEVELS.has(level)) continue;
    const ts = resolveTimestamp(now, Number(hh), Number(mm), Number(ss), Number(ms));
    if (ts.getTime() < cutoff) continue;
    entries.push({ timestamp: ts.toISOString(), level, message: line });
  }
  return { missingFile: false, entries };
}

/**
 * The log line carries no date, only HH:MM:SS.mmm (src/log.ts's ts()).
 * Assume the line is from today unless that would place it in the future
 * (allowing 1s of clock skew), in which case it's from yesterday — the one
 * case a window under 24h can actually hit is crossing midnight.
 */
function resolveTimestamp(now: Date, hh: number, mm: number, ss: number, ms: number): Date {
  const candidate = new Date(now);
  candidate.setHours(hh, mm, ss, ms);
  if (candidate.getTime() > now.getTime() + 1000) {
    candidate.setDate(candidate.getDate() - 1);
  }
  return candidate;
}

function readTail(filePath: string, maxBytes: number): string {
  const { size } = fs.statSync(filePath);
  if (size <= maxBytes) return fs.readFileSync(filePath, 'utf8');
  const fd = fs.openSync(filePath, 'r');
  try {
    const start = size - maxBytes;
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, start);
    const text = buf.toString('utf8');
    // The read almost certainly starts mid-line; drop that partial line.
    const firstNewline = text.indexOf('\n');
    return firstNewline === -1 ? text : text.slice(firstNewline + 1);
  } finally {
    fs.closeSync(fd);
  }
}

export function formatHealthReportHuman(report: HealthReport): string {
  const lines: string[] = [];
  lines.push(`NanoClaw health — ${report.generatedAt}`);
  lines.push('');

  if (report.host.running) {
    lines.push(`Host: running (${report.host.instances.length} instance${report.host.instances.length === 1 ? '' : 's'})`);
    for (const inst of report.host.instances) {
      lines.push(
        `  ${inst.instanceId}  pid=${inst.pid ?? '?'}  host=${inst.hostname ?? '?'}  uptime=${formatDuration(inst.uptimeSeconds)}`,
      );
    }
  } else {
    lines.push('Host: not running (no live lease found)');
  }

  lines.push('');
  if (report.sessions.length === 0) {
    lines.push('Sessions: none');
  } else {
    lines.push(`Sessions (${report.sessions.length}):`);
    for (const s of report.sessions) {
      lines.push(
        `  ${s.id}  group=${s.agentGroupName ?? s.agentGroupId}  status=${s.status}  container=${s.containerStatus}  last_active=${s.lastActive ?? 'never'}`,
      );
    }
  }

  lines.push('');
  if (report.recentErrors.length === 0) {
    lines.push('Recent errors: none');
  } else {
    lines.push(`Recent errors (${report.recentErrors.length}):`);
    for (const e of report.recentErrors) lines.push(`  ${e.message}`);
  }

  lines.push('');
  if (report.expiringApprovals.length === 0) {
    lines.push('Approvals nearing expiry: none');
  } else {
    lines.push(`Approvals nearing expiry (${report.expiringApprovals.length}):`);
    for (const a of report.expiringApprovals) {
      lines.push(`  ${a.approvalId}  action=${a.action}  "${a.title}"  expires in ${a.secondsRemaining}s`);
    }
  }

  if (report.notes.length > 0) {
    lines.push('');
    lines.push('Notes:');
    for (const n of report.notes) lines.push(`  - ${n}`);
  }

  return lines.join('\n');
}

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}
