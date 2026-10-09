#!/usr/bin/env tsx
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { execSync, spawnSync } from 'child_process';
import { buildPrompt } from './watchdog-prompt.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return undefined;
}

const repo = getArg('--repo') ?? process.cwd();
const sessionsDir = getArg('--sessions-dir') ?? path.join(repo, 'data', 'v2-sessions');

const SERVICE_NAME = '__NANOCLAW_SERVICE_NAME__';
const STUCK_THRESHOLD_MIN = 45;
const STUCK_THRESHOLD_MS = STUCK_THRESHOLD_MIN * 60 * 1000;

const logsDir = path.join(repo, 'logs');
const logFile = path.join(logsDir, 'watchdog.log');
let logDirEnsured = false;

function ensureLogDir(): void {
  if (!logDirEnsured) {
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    logDirEnsured = true;
  }
}

function log(level: 'INFO' | 'WARN' | 'ERROR', message: string): void {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  console.log(line);
  try {
    ensureLogDir();
    fs.appendFileSync(logFile, line + '\n');
  } catch (e) {
    console.error(`[watchdog] Failed to write to log file: ${e}`);
  }
}

export interface WatchdogIssue {
  agentGroupId: string;
  sessionId: string;
  dbPath: string;
  type: 'dead-recurring' | 'stuck-processing' | 'service-down';
  detail: string;
}

function discoverSessions(): Array<{ agentGroupId: string; sessionId: string; dbPath: string }> {
  const results: Array<{ agentGroupId: string; sessionId: string; dbPath: string }> = [];

  if (!fs.existsSync(sessionsDir)) {
    log('WARN', `Sessions directory does not exist: ${sessionsDir}`);
    return results;
  }

  let agentGroupDirs: string[];
  try {
    agentGroupDirs = fs.readdirSync(sessionsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch (e) {
    log('ERROR', `Failed to read sessions directory: ${e}`);
    return results;
  }

  for (const agentGroupId of agentGroupDirs) {
    const agGroupPath = path.join(sessionsDir, agentGroupId);
    let sessionDirs: string[];
    try {
      sessionDirs = fs.readdirSync(agGroupPath, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch (e) {
      log('WARN', `Failed to read agent group dir ${agGroupPath}: ${e}`);
      continue;
    }

    for (const sessionId of sessionDirs) {
      const dbPath = path.join(agGroupPath, sessionId, 'inbound.db');
      if (fs.existsSync(dbPath)) {
        results.push({ agentGroupId, sessionId, dbPath });
      }
    }
  }

  return results;
}

interface FailedRecurringRow { id: string; recurrence: string; tries: number; }

function checkDeadRecurring(agentGroupId: string, sessionId: string, dbPath: string): WatchdogIssue[] {
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    db.pragma('busy_timeout = 3000');
    const rows = db.prepare(
      `SELECT id, recurrence, tries FROM messages_in WHERE status='failed' AND recurrence IS NOT NULL`,
    ).all() as FailedRecurringRow[];
    return rows.map(row => ({
      agentGroupId, sessionId, dbPath,
      type: 'dead-recurring' as const,
      detail: `message id=${row.id} tries=${row.tries} recurrence=${row.recurrence}`,
    }));
  } catch (e) {
    log('WARN', `check-dead-recurring: failed to query ${dbPath}: ${e}`);
    return [];
  } finally {
    db?.close();
  }
}

interface ProcessingRow { id: string; timestamp: string; }

function isHeartbeatStale(heartbeatPath: string): boolean {
  try {
    const stat = fs.statSync(heartbeatPath);
    return Date.now() - stat.mtimeMs > STUCK_THRESHOLD_MS;
  } catch {
    return true;
  }
}

function checkStuckProcessing(agentGroupId: string, sessionId: string, dbPath: string): WatchdogIssue[] {
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    db.pragma('busy_timeout = 3000');
    const rows = db.prepare(
      `SELECT id, timestamp FROM messages_in
       WHERE status='processing'
         AND datetime(timestamp) < datetime('now', '-${STUCK_THRESHOLD_MIN} minutes')`,
    ).all() as ProcessingRow[];

    if (rows.length === 0) return [];

    const heartbeatPath = path.join(path.dirname(dbPath), '.heartbeat');
    if (!isHeartbeatStale(heartbeatPath)) return [];

    return rows.map(row => ({
      agentGroupId, sessionId, dbPath,
      type: 'stuck-processing' as const,
      detail: `message id=${row.id} timestamp=${row.timestamp} heartbeat=absent-or-stale`,
    }));
  } catch (e) {
    log('WARN', `check-stuck-processing: failed to query ${dbPath}: ${e}`);
    return [];
  } finally {
    db?.close();
  }
}

function checkServiceDown(): WatchdogIssue | null {
  try {
    execSync(`systemctl --user is-active ${SERVICE_NAME}`, { stdio: 'pipe' });
    return null;
  } catch {
    return {
      agentGroupId: '', sessionId: '', dbPath: '',
      type: 'service-down',
      detail: `${SERVICE_NAME} is not active`,
    };
  }
}

const centralDb = path.join(repo, 'data', 'v2.db');

function lookupAgentGroupName(agentGroupId: string): string {
  if (!agentGroupId) return 'unknown';
  let db: Database.Database | null = null;
  try {
    db = new Database(centralDb, { readonly: true });
    db.pragma('busy_timeout = 3000');
    const row = db.prepare('SELECT name FROM agent_groups WHERE id = ?').get(agentGroupId) as
      | { name: string } | undefined;
    return row?.name ?? agentGroupId;
  } catch (e) {
    log('WARN', `lookupAgentGroupName: could not query central DB: ${e}`);
    return agentGroupId;
  } finally {
    db?.close();
  }
}

function handleIssue(issue: WatchdogIssue): void {
  const agentGroupName = lookupAgentGroupName(issue.agentGroupId);
  const prompt = buildPrompt(issue, agentGroupName, repo);

  const header =
    `\n${'='.repeat(72)}\n` +
    `[${new Date().toISOString()}] WATCHDOG REMEDIATION: ${issue.type}\n` +
    `  agentGroupId=${issue.agentGroupId} sessionId=${issue.sessionId}\n` +
    `  detail=${issue.detail}\n` +
    `${'='.repeat(72)}\n`;

  log('INFO', `invoking claude for issue: ${issue.type} (agent=${agentGroupName})`);

  const result = spawnSync('claude', ['--dangerously-skip-permissions', '-p', prompt], {
    stdio: 'pipe',
    encoding: 'utf8',
  });

  const stderrBlock = result.stderr?.trim() ? `--- stderr ---\n${result.stderr}` : '';
  const output = [header, result.stdout ?? '', stderrBlock, `--- exit code: ${result.status ?? 'null'} ---\n`]
    .filter(Boolean).join('\n');

  try {
    ensureLogDir();
    fs.appendFileSync(logFile, output);
  } catch (e) {
    console.error(`[watchdog] Failed to append claude output to log: ${e}`);
  }

  if (result.status !== 0) {
    log('WARN', `claude exited with code ${result.status} for issue ${issue.type}`);
  } else {
    log('INFO', `claude remediation complete for issue: ${issue.type}`);
  }
}

async function main(): Promise<void> {
  ensureLogDir();
  log('INFO', `watchdog starting (dry-run=${dryRun}, sessions-dir=${sessionsDir})`);

  const issues: WatchdogIssue[] = [];

  const sessions = discoverSessions();
  log('INFO', `discovered ${sessions.length} session(s)`);

  for (const { agentGroupId, sessionId, dbPath } of sessions) {
    issues.push(
      ...checkDeadRecurring(agentGroupId, sessionId, dbPath),
      ...checkStuckProcessing(agentGroupId, sessionId, dbPath),
    );
  }

  const serviceIssue = checkServiceDown();
  if (serviceIssue) issues.push(serviceIssue);

  if (issues.length === 0) {
    log('INFO', 'no issues detected');
  } else {
    log('WARN', `detected ${issues.length} issue(s):`);
    for (const issue of issues) {
      const loc = issue.sessionId
        ? `ag=${issue.agentGroupId} sess=${issue.sessionId}`
        : 'global';
      log('WARN', `  [${issue.type}] ${loc} — ${issue.detail}`);
    }
  }

  if (dryRun) {
    log('INFO', 'dry-run mode — exiting without remediation');
    process.exit(0);
  }

  for (const issue of issues) {
    handleIssue(issue);
  }

  log('INFO', 'watchdog done');
}

main().catch(e => {
  log('ERROR', `watchdog crashed: ${e}`);
  process.exit(1);
});
