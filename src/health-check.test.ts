/**
 * Behavior tests for `ncl health` (#2504). `collectHealthReport` is the part
 * that matters — it's what `src/cli/client.ts` calls before ever picking a
 * transport, precisely so this keeps working with no host process running.
 * These tests drive it against a real, file-based SQLite DB and real
 * migrations (not mocks), the same way src/cli/resources/destinations.test.ts
 * drives `dispatch()` — the difference here is there's no dispatch to go
 * through at all.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const TEST_DIR = '/tmp/nanoclaw-test-health-check';
const DB_PATH = path.join(TEST_DIR, 'v2.db');
const LOG_PATH = path.join(TEST_DIR, 'nanoclaw.error.log');

import { closeDb, initDb, runMigrations, createAgentGroup, createSession, createPendingApproval } from './db/index.js';
import { registerHostInstance } from './db/coordination.js';
import { collectHealthReport, formatHealthReportHuman } from './health-check.js';

const NOW = new Date('2026-09-19T12:00:00.000Z');

function writeLog(lines: string[]): void {
  fs.writeFileSync(LOG_PATH, lines.join('\n') + '\n');
}

// src/log.ts's ts() writes LOCAL wall-clock HH:MM:SS.mmm, with no date. Build
// fixture lines the same way — from an instant, via local-time getters — so
// these tests are correct under any runner timezone (this sandbox happens to
// be UTC+10; NanoClaw's own CI may be anything).
function localTimeString(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initDb(DB_PATH, { role: 'test' });
  await runMigrations(db);
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('collectHealthReport — no install yet', () => {
  it('degrades cleanly when the central DB does not exist', async () => {
    await closeDb();
    const report = await collectHealthReport({
      dbPath: path.join(TEST_DIR, 'does-not-exist.db'),
      logPath: LOG_PATH,
      now: NOW,
    });
    expect(report.host).toEqual({ running: false, instances: [] });
    expect(report.sessions).toEqual([]);
    expect(report.expiringApprovals).toEqual([]);
    expect(report.notes.some((n) => n.includes('central database not found'))).toBe(true);
  });

  it('degrades cleanly when the error log does not exist', async () => {
    await closeDb();
    const report = await collectHealthReport({ dbPath: DB_PATH, logPath: LOG_PATH, now: NOW });
    expect(report.recentErrors).toEqual([]);
    expect(report.notes.some((n) => n.includes('no error log found'))).toBe(true);
  });
});

describe('collectHealthReport — host liveness', () => {
  it('reports not-running when no live lease exists', async () => {
    await closeDb();
    writeLog([]);
    const report = await collectHealthReport({ dbPath: DB_PATH, logPath: LOG_PATH, now: NOW });
    expect(report.host.running).toBe(false);
  });

  it('reports a live instance with computed uptime, and ignores an expired lease', async () => {
    await registerHostInstance({
      instanceId: 'live-1',
      installId: 'install-1',
      hostname: 'mac.local',
      pid: 4242,
      now: '2026-09-19T11:00:00.000Z',
      leaseExpiresAt: '2026-09-19T13:00:00.000Z', // ahead of NOW
    });
    await registerHostInstance({
      instanceId: 'stale-1',
      installId: 'install-1',
      hostname: 'mac.local',
      pid: 1,
      now: '2026-09-19T09:00:00.000Z',
      leaseExpiresAt: '2026-09-19T09:30:00.000Z', // behind NOW — expired
    });
    await closeDb();
    writeLog([]);

    const report = await collectHealthReport({ dbPath: DB_PATH, logPath: LOG_PATH, now: NOW });
    expect(report.host.running).toBe(true);
    expect(report.host.instances).toHaveLength(1);
    expect(report.host.instances[0]).toMatchObject({ instanceId: 'live-1', pid: 4242, uptimeSeconds: 3600 });
  });
});

describe('collectHealthReport — sessions', () => {
  it('joins the agent group name and orders by last_active desc', async () => {
    await createAgentGroup({ id: 'g1', name: 'Ops Bot', folder: 'ops-bot', agent_provider: null, created_at: NOW.toISOString() });
    await createSession({
      id: 's-old',
      agent_group_id: 'g1',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'running',
      last_active: '2026-09-19T10:00:00.000Z',
      created_at: '2026-09-19T09:00:00.000Z',
    });
    await createSession({
      id: 's-new',
      agent_group_id: 'g1',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'idle',
      last_active: '2026-09-19T11:30:00.000Z',
      created_at: '2026-09-19T09:00:00.000Z',
    });
    await closeDb();
    writeLog([]);

    const report = await collectHealthReport({ dbPath: DB_PATH, logPath: LOG_PATH, now: NOW });
    expect(report.sessions.map((s) => s.id)).toEqual(['s-new', 's-old']);
    expect(report.sessions[0]).toMatchObject({ agentGroupName: 'Ops Bot', containerStatus: 'idle' });
  });
});

describe('collectHealthReport — expiring approvals', () => {
  it('includes only pending approvals expiring within the window', async () => {
    await createPendingApproval({
      approval_id: 'a-soon',
      request_id: 'r1',
      action: 'onecli_credential',
      payload: '{}',
      created_at: NOW.toISOString(),
      title: 'Renew API token',
      options_json: '[]',
      expires_at: '2026-09-19T12:10:00.000Z', // 10 min out — within the 15 min default window
    });
    await createPendingApproval({
      approval_id: 'a-later',
      request_id: 'r2',
      action: 'install_packages',
      payload: '{}',
      created_at: NOW.toISOString(),
      title: 'Install ffmpeg',
      options_json: '[]',
      expires_at: '2026-09-19T14:00:00.000Z', // 2h out — outside the window
    });
    await closeDb();
    writeLog([]);

    const report = await collectHealthReport({ dbPath: DB_PATH, logPath: LOG_PATH, now: NOW });
    expect(report.expiringApprovals).toHaveLength(1);
    expect(report.expiringApprovals[0]).toMatchObject({ approvalId: 'a-soon', secondsRemaining: 600 });
  });
});

describe('collectHealthReport — recent errors', () => {
  it('keeps only warn/error/fatal lines inside the window, strips ANSI, and skips unrelated lines', async () => {
    await closeDb();
    const thirtyMinAgo = localTimeString(new Date(NOW.getTime() - 30 * 60 * 1000)); // inside the 1h window
    const threeHoursAgo = localTimeString(new Date(NOW.getTime() - 3 * 60 * 60 * 1000)); // outside it
    writeLog([
      '\x1b[32mINFO\x1b[39m plain info line, should be dropped',
      `[${thirtyMinAgo}] \x1b[31mERROR\x1b[39m \x1b[36mdelivery failed\x1b[39m \x1b[35msession\x1b[39m="s1"`,
      `[${threeHoursAgo}] \x1b[33mWARN\x1b[39m \x1b[36mstale channel token\x1b[39m`,
      'not a log line at all',
    ]);
    const report = await collectHealthReport({ dbPath: DB_PATH, logPath: LOG_PATH, now: NOW });
    expect(report.recentErrors).toHaveLength(1);
    expect(report.recentErrors[0].level).toBe('ERROR');
    expect(report.recentErrors[0].message).toContain('delivery failed');
    expect(report.recentErrors[0].message).not.toContain('\x1b');
  });

  it('resolves an HH:MM:SS line crossing midnight to yesterday, not tomorrow', async () => {
    await closeDb();
    // now = local 00:10 today; a line 20 minutes earlier is local 23:50
    // *yesterday* — must resolve to the past, not ~24h in the future.
    const nearMidnight = new Date();
    nearMidnight.setHours(0, 10, 0, 0);
    const twentyMinEarlier = new Date(nearMidnight.getTime() - 20 * 60 * 1000);
    writeLog([`[${localTimeString(twentyMinEarlier)}] ERROR something broke near midnight`]);
    const report = await collectHealthReport({ dbPath: DB_PATH, logPath: LOG_PATH, now: nearMidnight });
    expect(report.recentErrors).toHaveLength(1);
    expect(new Date(report.recentErrors[0].timestamp).getTime()).toBeLessThan(nearMidnight.getTime());
  });

  it('tails a large log file instead of reading it whole', async () => {
    await closeDb();
    const filler = 'x'.repeat(2_000_000); // 2MB of junk, well past the 1MB tail cap
    const oneMinAgo = localTimeString(new Date(NOW.getTime() - 60 * 1000));
    const recentLine = `[${oneMinAgo}] ERROR the needle`;
    fs.writeFileSync(LOG_PATH, filler + '\n' + recentLine + '\n');
    const report = await collectHealthReport({ dbPath: DB_PATH, logPath: LOG_PATH, now: NOW });
    expect(report.recentErrors.some((e) => e.message.includes('the needle'))).toBe(true);
  });
});

describe('formatHealthReportHuman', () => {
  it('renders a readable summary with no throw on an all-empty report', () => {
    const text = formatHealthReportHuman({
      generatedAt: NOW.toISOString(),
      host: { running: false, instances: [] },
      sessions: [],
      recentErrors: [],
      expiringApprovals: [],
      notes: ['central database not found at /tmp/nope — this install has never started'],
    });
    expect(text).toContain('Host: not running');
    expect(text).toContain('Sessions: none');
    expect(text).toContain('Notes:');
  });
});
