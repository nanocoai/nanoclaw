/**
 * Turn traces against the composed host: the real modules barrel, the real
 * migration runner, the delivery-action registry and `ncl` dispatch. Goes red
 * if the barrel line is deleted, the migration stops applying, the action or
 * resource stops registering, or expired traces stop being pruned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { getDeliveryAction } from '../../delivery.js';
import { dispatch } from '../../cli/dispatch.js';
import type { Session } from '../../types.js';
import '../index.js';
import { stopTurnTraceRetention } from './retention.js';

const session: Session = {
  id: 'sess-1',
  agent_group_id: 'ag-1',
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'running',
  last_active: null,
  created_at: new Date().toISOString(),
};

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'turn_trace',
    turn_id: 'm-1',
    message_ids: ['m-1'],
    provider: 'claude',
    model: 'test-model',
    status: 'ok',
    started_at: '2026-01-01T00:00:00.000Z',
    ended_at: '2026-01-01T00:00:02.000Z',
    duration_ms: 2000,
    input: '{"text":"hello"}',
    output: 'hi there',
    error: null,
    steps: [
      { type: 'tool', name: 'Bash', input: '{"command":"ls"}', output: 'a.txt', is_error: false, duration_ms: 5 },
      { type: 'text', text: 'working' },
    ],
    steps_dropped: 0,
    ...overrides,
  };
}

async function ncl(command: string, args: Record<string, unknown>) {
  const resp = await dispatch({ id: `req-${command}`, command, args }, { caller: 'host' });
  if (!resp.ok) throw new Error(resp.error.message);
  return resp.data;
}

async function expire(turnId: string): Promise<void> {
  await getDb().run("UPDATE turn_traces SET created_at = '2000-01-01T00:00:00.000Z' WHERE turn_id = ?", turnId);
}

async function idOf(turnId: string): Promise<string> {
  const row = await getDb().get<{ id: string }>('SELECT id FROM turn_traces WHERE turn_id = ?', turnId);
  if (!row) throw new Error(`no trace for ${turnId}`);
  return row.id;
}

beforeEach(async () => {
  stopTurnTraceRetention();
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  stopTurnTraceRetention();
  await closeDb();
});

describe('turn traces host module', () => {
  it('stores a turn_trace action and lists it through ncl', async () => {
    const apply = getDeliveryAction('turn_trace');
    expect(apply).toBeDefined();
    await apply!(payload(), session);

    const rows = (await ncl('traces-list', {})) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent_group_id: 'ag-1',
      session_id: 'sess-1',
      status: 'ok',
      model: 'test-model',
      duration_ms: 2000,
      tool_call_count: 1,
      output: 'hi there',
    });

    const full = (await ncl('traces-get', { id: rows[0].id })) as Record<string, unknown>;
    expect(full.message_ids).toEqual(['m-1']);
    expect(full.steps).toHaveLength(2);
    expect(full.input).toBe('{"text":"hello"}');
  });

  it('filters by agent group and status', async () => {
    const apply = getDeliveryAction('turn_trace')!;
    await apply(payload(), session);
    await apply(payload({ status: 'error', error: 'boom' }), { ...session, agent_group_id: 'ag-2' });

    const errors = (await ncl('traces-list', { status: 'error' })) as Array<Record<string, unknown>>;
    expect(errors.map((r) => r.agent_group_id)).toEqual(['ag-2']);
    const group = (await ncl('traces-list', { 'agent-group-id': 'ag-1' })) as Array<Record<string, unknown>>;
    expect(group.map((r) => r.status)).toEqual(['ok']);
  });

  it('drops a payload with an unknown status', async () => {
    await getDeliveryAction('turn_trace')!(payload({ status: 'bogus' }), session);
    expect(await ncl('traces-list', {})).toEqual([]);
  });

  it('refuses container callers, whatever their scope', async () => {
    const resp = await dispatch(
      { id: 'req-agent', command: 'traces-list', args: {} },
      { caller: 'agent', sessionId: 'sess-1', agentGroupId: 'ag-1', messagingGroupId: 'mg-1' },
    );
    expect(resp.ok).toBe(false);
  });

  it('never lists a trace past the retention window', async () => {
    await getDeliveryAction('turn_trace')!(payload(), session);
    await expire('m-1');
    const expiredId = await idOf('m-1');
    await getDeliveryAction('turn_trace')!(payload({ turn_id: 'm-2' }), session);

    await expect(ncl('traces-get', { id: expiredId })).rejects.toThrow(/not found/);
    const rows = (await ncl('traces-list', {})) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
  });

  it('prunes expired traces when the first trace of a host process is recorded', async () => {
    await getDeliveryAction('turn_trace')!(payload(), session);
    await expire('m-1');
    stopTurnTraceRetention();
    await getDeliveryAction('turn_trace')!(payload({ turn_id: 'm-2' }), session);

    const left = await getDb().all<{ turn_id: string }>('SELECT turn_id FROM turn_traces');
    expect(left.map((r) => r.turn_id)).toEqual(['m-2']);
  });
});
