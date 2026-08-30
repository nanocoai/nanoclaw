import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

import type { MailboxSession } from '../mailbox/index.js';

const state = vi.hoisted(() => ({
  mailbox: null as MailboxSession | null,
  taskRuns: [] as Array<Record<string, unknown>>,
  sweepCallbacks: [] as Array<() => void>,
}));

const session = {
  id: 'recurring-session',
  agent_group_id: 'recurring-agent',
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active' as const,
  container_status: 'running' as const,
  last_active: '2026-08-23T10:00:00.000Z',
  created_at: '2026-08-23T10:00:00.000Z',
};

vi.mock('./runtime-emitters.js', () => ({
  emitTaskRun: (activity: Record<string, unknown>) => state.taskRuns.push(activity),
}));
vi.mock('../db/agent-groups.js', () => ({
  getAgentGroup: vi.fn(async () => ({ id: session.agent_group_id, name: 'Recurring Agent' })),
}));
vi.mock('../db/coordination.js', () => ({
  getSessionClaim: vi.fn(async () => null),
}));
vi.mock('../db/sessions.js', () => ({
  getActiveSessions: vi.fn(async () => [session]),
  isTaskThread: vi.fn(() => false),
  updateSession: vi.fn(),
}));
vi.mock('../session-manager.js', () => ({
  heartbeatPath: vi.fn(() => '/tmp/host-audit-recurring-no-heartbeat'),
  withExistingMailboxSession: vi.fn(async (...args: unknown[]) => {
    const callback = args.at(-1) as (mailbox: MailboxSession) => unknown;
    if (!state.mailbox) throw new Error('real mailbox not initialized');
    return await callback(state.mailbox);
  }),
}));
vi.mock('../container-runner.js', () => ({
  getContainerStartedAtMs: vi.fn(() => Date.now()),
  isContainerRunning: vi.fn(() => true),
  killContainer: vi.fn(),
}));
vi.mock('../request-wake.js', () => ({ requestWake: vi.fn(async () => undefined) }));
vi.mock('../container-config.js', () => ({ resolveGroupTimezone: vi.fn(async () => 'UTC') }));
vi.mock('../modules/approvals/index.js', () => ({ sweepAwaitingReasonRejects: vi.fn(async () => undefined) }));
vi.mock('../modules/cross-session-context/index.js', () => ({ pruneEchoBacklog: vi.fn(() => 0) }));
vi.mock('../egress-lockdown.js', () => ({ ensureEgressNetwork: vi.fn() }));
vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { startHostSweep, stopHostSweep } from '../host-sweep.js';
import { wrapSqliteInbound, wrapSqliteOutbound } from '../mailbox/sqlite/index.js';
import { ensureSchema, openInboundDb, openOutboundDbRw } from '../mailbox/sqlite/session-db.js';

const realSetTimeout = global.setTimeout;
let timeoutSpy: ReturnType<typeof vi.spyOn>;
let testDir: string;
let inboundDb: Database.Database;
let outboundDb: Database.Database;

async function runSweepTick(): Promise<void> {
  const before = state.sweepCallbacks.length;
  if (before === 0) startHostSweep();
  else state.sweepCallbacks[before - 1]();
  await vi.waitFor(() => expect(state.sweepCallbacks.length).toBe(before + 1));
}

beforeEach(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-audit-recurring-'));
  const inboundPath = path.join(testDir, 'inbound.db');
  const outboundPath = path.join(testDir, 'outbound.db');
  ensureSchema(inboundPath, 'inbound');
  ensureSchema(outboundPath, 'outbound');
  inboundDb = openInboundDb(inboundPath);
  outboundDb = openOutboundDbRw(outboundPath);
  const inbound = wrapSqliteInbound(inboundDb);
  const outbound = wrapSqliteOutbound(outboundDb);
  state.mailbox = { ...inbound, ...outbound };
  state.taskRuns.splice(0);
  state.sweepCallbacks.splice(0);

  await inbound.insertTask({
    id: 'task-occurrence-1',
    seriesId: 'task-occurrence-1',
    processAfter: '2026-08-23T10:00:00.000Z',
    recurrence: '0 9 * * *',
    content: JSON.stringify({ prompt: 'PRIVATE RECURRING TASK BODY' }),
  });
  outboundDb.prepare(
    'INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)',
  ).run('task-occurrence-1', 'completed', '2026-08-23T10:01:00.000Z');

  timeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
    if (ms === 60_000) {
      state.sweepCallbacks.push(fn);
      return 0 as unknown as NodeJS.Timeout;
    }
    return realSetTimeout(fn, ms);
  }) as typeof setTimeout);
});

afterEach(async () => {
  await stopHostSweep();
  timeoutSpy.mockRestore();
  state.mailbox = null;
  inboundDb.close();
  outboundDb.close();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('recurring task occurrence evidence', () => {
  it('emits the acknowledged occurrence once across recurrence, later sweeps, and restart', async () => {
    await runSweepTick();
    expect(state.taskRuns).toEqual([{
      agentId: 'recurring-agent',
      sessionId: 'recurring-session',
      seriesId: 'task-occurrence-1',
      activityId: 'task-occurrence-1',
      outcome: 'success',
    }]);

    const rows = inboundDb.prepare(
      "SELECT id, series_id, status FROM messages_in WHERE kind = 'task' ORDER BY seq",
    ).all() as Array<{ id: string; series_id: string; status: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ id: 'task-occurrence-1', series_id: 'task-occurrence-1', status: 'completed' });
    expect(rows[1].status).toBe('pending');
    expect(rows[1].series_id).toBe('task-occurrence-1');

    await runSweepTick();
    expect(state.taskRuns).toHaveLength(1);

    await stopHostSweep();
    state.sweepCallbacks.splice(0);
    await runSweepTick();
    expect(state.taskRuns).toHaveLength(1);
    expect(JSON.stringify(state.taskRuns)).not.toContain('PRIVATE RECURRING TASK BODY');
  });
});
