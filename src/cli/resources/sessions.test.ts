import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-cli-sessions',
    GROUPS_DIR: '/tmp/nanoclaw-test-cli-sessions/groups',
    TIMEZONE: 'UTC',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-sessions';

import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { initSessionFolder, outboundDbPath } from '../../session-manager.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext } from '../frame.js';
import './sessions.js';

function now(): string {
  return new Date().toISOString();
}

function createGroup(id: string): void {
  createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
}

function createChatSession(group: string, id: string): void {
  createSession({
    id,
    agent_group_id: group,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
  initSessionFolder(group, id);
}

/** Stand in for the container: write the totals row the poll loop accumulates. */
function seedUsage(group: string, session: string, totals: Record<string, unknown>): void {
  const db = new Database(outboundDbPath(group, session));
  db.prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)').run(
    'token_usage',
    JSON.stringify(totals),
    now(),
  );
  db.close();
}

function agentCtx(group = 'ag-1', session = 'chat-1'): CallerContext {
  return { caller: 'agent', agentGroupId: group, sessionId: session, messagingGroupId: 'mg-1' };
}

interface UsageRow {
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

interface UsageReport {
  sessions: UsageRow[];
  totals: Omit<UsageRow, 'session_id' | 'agent_group_id' | 'updated_at'> & { sessions: number };
  unreported: number;
}

async function usage(args: Record<string, unknown>, ctx: CallerContext) {
  return dispatch({ id: 'req-1', command: 'sessions-usage', args }, ctx);
}

describe('sessions usage', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = initTestDb();
    runMigrations(db);
    createGroup('ag-1');
    createGroup('ag-2');
    createChatSession('ag-1', 'chat-1');
    createChatSession('ag-1', 'chat-2');
    createChatSession('ag-2', 'chat-3');
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('reports what a session banked, and derives the token total', async () => {
    seedUsage('ag-1', 'chat-1', {
      input_tokens: 120,
      output_tokens: 45,
      cache_read_tokens: 8000,
      cache_creation_tokens: 900,
      cost_usd: 0.0321,
      turns: 3,
      updated_at: '2026-08-14T10:00:00.000Z',
    });

    const resp = await usage({}, agentCtx());
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    const report = resp.data as UsageReport;

    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0]).toMatchObject({
      session_id: 'chat-1',
      agent_group_id: 'ag-1',
      input_tokens: 120,
      output_tokens: 45,
      cache_read_tokens: 8000,
      cache_creation_tokens: 900,
      // Cache reads and writes are tokens the account paid for; a total that
      // ignored them would understate a cache-heavy session several-fold.
      total_tokens: 9065,
      cost_usd: 0.0321,
      turns: 3,
    });
  });

  it('adds up every session in the group and counts the silent ones separately', async () => {
    seedUsage('ag-1', 'chat-1', { input_tokens: 100, output_tokens: 10, cost_usd: 0.01, turns: 1 });
    seedUsage('ag-1', 'chat-2', { input_tokens: 200, output_tokens: 20, cost_usd: 0.02, turns: 2 });

    const resp = await usage({}, agentCtx());
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    const report = resp.data as UsageReport;

    expect(report.totals).toMatchObject({
      input_tokens: 300,
      output_tokens: 30,
      total_tokens: 330,
      cost_usd: 0.03,
      turns: 3,
      sessions: 2,
    });
    expect(report.unreported).toBe(0);
  });

  it('counts a session that reported nothing rather than crediting it with zero', async () => {
    // A zero row would read as "this session was free". It wasn't measured —
    // a different claim, and the one an operator needs to see.
    seedUsage('ag-1', 'chat-1', { input_tokens: 100, output_tokens: 10, cost_usd: 0.01, turns: 1 });

    const resp = await usage({}, agentCtx());
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    const report = resp.data as UsageReport;

    expect(report.sessions.map((s) => s.session_id)).toEqual(['chat-1']);
    expect(report.unreported).toBe(1);
    expect(report.totals.sessions).toBe(1);
  });

  it('never reports another group, even when the caller names it', async () => {
    seedUsage('ag-2', 'chat-3', { input_tokens: 999, output_tokens: 999, cost_usd: 9.99, turns: 9 });

    const resp = await usage({ group: 'ag-2' }, agentCtx());
    expect(resp.ok).toBe(false);
    if (resp.ok) return;
    expect(resp.error.code).toBe('forbidden');
  });

  it('refuses a session id belonging to another group the same way as a missing one', async () => {
    seedUsage('ag-2', 'chat-3', { input_tokens: 999, output_tokens: 999, cost_usd: 9.99, turns: 9 });

    const resp = await usage({ session: 'chat-3' }, agentCtx());
    expect(resp.ok).toBe(false);
    if (resp.ok) return;
    expect(resp.error.message).toContain('chat-3');
  });

  it('a host caller sees every group', async () => {
    seedUsage('ag-1', 'chat-1', { input_tokens: 100, output_tokens: 10, cost_usd: 0.01, turns: 1 });
    seedUsage('ag-2', 'chat-3', { input_tokens: 5, output_tokens: 5, cost_usd: 0.005, turns: 1 });

    const resp = await usage({}, { caller: 'host' });
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    const report = resp.data as UsageReport;
    expect(report.sessions.map((s) => s.session_id).sort()).toEqual(['chat-1', 'chat-3']);
    expect(report.totals.cost_usd).toBe(0.015);
  });

  it('a session whose outbound DB is gone is skipped, not fatal', async () => {
    seedUsage('ag-1', 'chat-1', { input_tokens: 100, output_tokens: 10, cost_usd: 0.01, turns: 1 });
    fs.rmSync(outboundDbPath('ag-1', 'chat-2'));

    const resp = await usage({}, agentCtx());
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect((resp.data as UsageReport).sessions).toHaveLength(1);
  });

  it('a garbled totals row is unreported, not a poisoned total', async () => {
    seedUsage('ag-1', 'chat-1', { input_tokens: 100, output_tokens: 10, cost_usd: 0.01, turns: 1 });
    const db = new Database(outboundDbPath('ag-1', 'chat-2'));
    db.prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)').run(
      'token_usage',
      'not json',
      now(),
    );
    db.close();

    const resp = await usage({}, agentCtx());
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    const report = resp.data as UsageReport;
    expect(report.totals.input_tokens).toBe(100);
    expect(report.unreported).toBe(1);
  });

  it('renders a human table with a total line', async () => {
    seedUsage('ag-1', 'chat-1', {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_tokens: 20,
      cache_creation_tokens: 5,
      cost_usd: 0.01,
      turns: 1,
    });

    const resp = await usage({}, agentCtx());
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect(resp.human).toContain('chat-1');
    expect(resp.human).toContain('TOTAL');
    expect(resp.human).toContain('$0.01');
  });
});
