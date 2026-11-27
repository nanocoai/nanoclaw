import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: `/tmp/nanoclaw-test-remote-ops-${process.pid}` }));
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

import { inboundDbPath, outboundDbPath } from '../sqlite/paths.js';
import { openInboundDb, replaceDestinations, upsertSessionRouting } from '../sqlite/session-db.js';
import { createSessionOperations, SessionUnavailableError, sqliteTimestamp } from './operations.js';
import type { SessionOperations } from './operations.js';
import { createTestSession, hostInsert } from './test-fixture.js';
import type { RemoteSessionKey } from './ids.js';

let key: RemoteSessionKey;
let ops: SessionOperations;

function outboundRows<T>(sql: string, ...params: unknown[]): T[] {
  const db = new Database(outboundDbPath(key.agentGroupId, key.sessionId), { readonly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

function inboundExec(fn: (db: Database.Database) => void): void {
  const db = openInboundDb(inboundDbPath(key.agentGroupId, key.sessionId));
  try {
    fn(db);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  ({ key } = createTestSession());
  ops = createSessionOperations(key);
});

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('getPendingMessages', () => {
  it('returns parsed records with even host sequences', () => {
    hostInsert(key, { id: 'm1', content: '{"text":"a"}' });
    hostInsert(key, { id: 'm2', content: '{"text":"b"}' });
    const pending = ops.getPendingMessages(10, true);
    expect(pending.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(pending[0]).toMatchObject({
      id: 'm1',
      sequence: 2,
      kind: 'chat',
      status: 'pending',
      trigger: true,
      onWake: false,
      platformId: 'plat-1',
      channelType: 'test',
      content: '{"text":"a"}',
    });
    expect(pending[1].sequence).toBe(4);
    expect(new Date(pending[0].timestamp).toISOString()).toBe(pending[0].timestamp);
  });

  it('skips future process_after and rows already acknowledged', () => {
    hostInsert(key, { id: 'now' });
    hostInsert(key, { id: 'later', processAfter: new Date(Date.now() + 3_600_000).toISOString() });
    hostInsert(key, { id: 'claimed' });
    ops.markMessages(['claimed'], 'processing');
    expect(ops.getPendingMessages(10, true).map((m) => m.id)).toEqual(['now']);
  });

  it('serves on_wake rows only on the first poll', () => {
    hostInsert(key, { id: 'wake', onWake: true });
    hostInsert(key, { id: 'plain' });
    expect(ops.getPendingMessages(10, true).map((m) => m.id)).toEqual(['wake', 'plain']);
    expect(ops.getPendingMessages(10, false).map((m) => m.id)).toEqual(['plain']);
  });

  it('keeps every wake row up to the limit and fills the rest with the newest context rows', () => {
    hostInsert(key, { id: 'ctx1', trigger: false });
    hostInsert(key, { id: 'ctx2', trigger: false });
    hostInsert(key, { id: 'ctx3', trigger: false });
    hostInsert(key, { id: 'wake1' });
    const ids = ops.getPendingMessages(3, true).map((m) => m.id);
    expect(ids).toEqual(['ctx2', 'ctx3', 'wake1']);
  });
});

describe('processing acknowledgements', () => {
  it('maps each status like the runner', () => {
    ops.markMessages(['p'], 'processing');
    ops.markMessages(['c'], 'completed');
    ops.markMessages(['f1', 'f2'], 'failed');
    ops.markMessages(['s'], 'script-skip:error');
    const rows = Object.fromEntries(
      outboundRows<{ message_id: string; status: string }>('SELECT message_id, status FROM processing_ack').map((r) => [
        r.message_id,
        r.status,
      ]),
    );
    expect(rows).toEqual({ p: 'processing', c: 'completed', f1: 'failed', f2: 'failed', s: 'script-skip:error' });
  });

  it('stamps status_changed with an ISO timestamp and replaces an earlier ack', () => {
    ops.markMessages(['x'], 'processing');
    ops.markMessages(['x'], 'completed');
    const rows = outboundRows<{ status: string; status_changed: string }>(
      "SELECT status, status_changed FROM processing_ack WHERE message_id = 'x'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('completed');
    expect(new Date(rows[0].status_changed).toISOString()).toBe(rows[0].status_changed);
  });

  it('markScriptSkipped records error skips as script-skip:error and others as completed', () => {
    ops.markScriptSkipped([
      { id: 'boom', reason: 'error' },
      { id: 'quiet', reason: 'no-op' },
    ]);
    const rows = Object.fromEntries(
      outboundRows<{ message_id: string; status: string }>('SELECT message_id, status FROM processing_ack').map((r) => [
        r.message_id,
        r.status,
      ]),
    );
    expect(rows).toEqual({ boom: 'script-skip:error', quiet: 'completed' });
  });

  it('empty id lists are a no-op', () => {
    ops.markMessages([], 'processing');
    ops.markScriptSkipped([]);
    expect(outboundRows('SELECT * FROM processing_ack')).toEqual([]);
  });

  it('clearStaleProcessingAcks removes only processing rows', () => {
    ops.markMessages(['p'], 'processing');
    ops.markMessages(['c'], 'completed');
    ops.clearStaleProcessingAcks();
    expect(
      outboundRows<{ message_id: string }>('SELECT message_id FROM processing_ack').map((r) => r.message_id),
    ).toEqual(['c']);
  });
});

describe('lookups', () => {
  it('getMessageIn returns a record or undefined', () => {
    hostInsert(key, { id: 'm1' });
    expect(ops.getMessageIn('m1')?.id).toBe('m1');
    expect(ops.getMessageIn('nope')).toBeUndefined();
  });

  it('findQuestionResponse ignores acknowledged responses', () => {
    hostInsert(key, { id: 'resp', kind: 'system', content: '{"type":"question_response","questionId":"q-1"}' });
    expect(ops.findQuestionResponse('q-1')?.id).toBe('resp');
    expect(ops.findQuestionResponse('q-2')).toBeUndefined();
    ops.markMessages(['resp'], 'processing');
    expect(ops.findQuestionResponse('q-1')).toBeUndefined();
  });

  it('findCliResponse matches on requestId even when acknowledged (runner parity)', () => {
    hostInsert(key, { id: 'cli', kind: 'system', content: '{"type":"cli_response","requestId":"r-1"}' });
    expect(ops.findCliResponse('r-1')?.id).toBe('cli');
    ops.markMessages(['cli'], 'processing');
    expect(ops.findCliResponse('r-1')?.id).toBe('cli');
    expect(ops.findCliResponse('r-2')).toBeUndefined();
  });

  it('getLatestInboundRoute returns the newest row for the route', () => {
    hostInsert(key, { id: 'a', channelType: 'tg', platformId: 'chat', threadId: 't1' });
    hostInsert(key, { id: 'b', channelType: 'tg', platformId: 'chat', threadId: null });
    expect(ops.getLatestInboundRoute('tg', 'chat')).toEqual({ threadId: null, inReplyTo: 'b' });
    expect(ops.getLatestInboundRoute('tg', 'other')).toBeNull();
  });

  it('getSessionRouting is all-null before the host sets it, then reflects it', () => {
    expect(ops.getSessionRouting()).toEqual({ channelType: null, platformId: null, threadId: null });
    inboundExec((db) => upsertSessionRouting(db, { channel_type: 'tg', platform_id: 'chat', thread_id: 'th' }));
    expect(ops.getSessionRouting()).toEqual({ channelType: 'tg', platformId: 'chat', threadId: 'th' });
  });

  it('destinations: list, by name, by routing (channel and agent)', () => {
    inboundExec((db) =>
      replaceDestinations(db, [
        {
          name: 'zed',
          display_name: null,
          type: 'agent',
          channel_type: null,
          platform_id: null,
          agent_group_id: 'ag-9',
        },
        {
          name: 'alpha',
          display_name: 'Alpha',
          type: 'channel',
          channel_type: 'tg',
          platform_id: 'chat-1',
          agent_group_id: null,
        },
      ]),
    );
    expect(ops.getDestinations().map((d) => d.name)).toEqual(['alpha', 'zed']);
    expect(ops.findDestinationByName('alpha')).toMatchObject({
      name: 'alpha',
      displayName: 'Alpha',
      type: 'channel',
      channelType: 'tg',
      platformId: 'chat-1',
      agentGroupId: null,
    });
    expect(ops.findDestinationByName('missing')).toBeUndefined();
    expect(ops.findDestinationByRouting('tg', 'chat-1')?.name).toBe('alpha');
    expect(ops.findDestinationByRouting('agent', 'ag-9')?.name).toBe('zed');
    expect(ops.findDestinationByRouting('tg', 'nope')).toBeUndefined();
  });
});

describe('writeMessageOut', () => {
  it('allocates odd sequences above the maximum of both DBs', () => {
    hostInsert(key, { id: 'in1' });
    hostInsert(key, { id: 'in2' }); // inbound max = 4
    const first = ops.writeMessageOut({ id: 'out1', kind: 'chat', content: '{"text":"x"}' });
    expect(first).toBe(5);
    const second = ops.writeMessageOut({ id: 'out2', kind: 'chat', content: '{"text":"y"}' });
    expect(second).toBe(7);
    hostInsert(key, { id: 'in3' }); // inbound max = 6 -> host even; outbound max 7 stays above
    expect(ops.writeMessageOut({ id: 'out3', kind: 'chat', content: '{"text":"z"}' })).toBe(9);
    expect(outboundRows<{ seq: number }>('SELECT seq FROM messages_out ORDER BY seq').map((r) => r.seq % 2)).toEqual([
      1, 1, 1,
    ]);
  });

  it('starts at 1 on empty DBs and jumps past an inbound maximum that is odd', () => {
    expect(ops.writeMessageOut({ id: 'first', kind: 'chat', content: 'x' })).toBe(1);
    inboundExec((db) =>
      db
        .prepare(
          "INSERT INTO messages_in (id, seq, kind, timestamp, content) VALUES ('odd', 11, 'chat', '2026-01-01T00:00:00.000Z', 'x')",
        )
        .run(),
    );
    expect(ops.writeMessageOut({ id: 'next', kind: 'chat', content: 'x' })).toBe(13);
  });

  it('stores the full record and returns it through getUndeliveredMessages', () => {
    const seq = ops.writeMessageOut({
      id: 'out1',
      kind: 'chat',
      content: '{"text":"hello"}',
      inReplyTo: 'in-x',
      platformId: 'chat',
      channelType: 'tg',
      threadId: 'th',
    });
    const [message] = ops.getUndeliveredMessages();
    expect(message).toMatchObject({
      id: 'out1',
      sequence: seq,
      inReplyTo: 'in-x',
      kind: 'chat',
      platformId: 'chat',
      channelType: 'tg',
      threadId: 'th',
      content: '{"text":"hello"}',
      deliverAfter: null,
      recurrence: null,
    });
    expect(new Date(message.timestamp).toISOString()).toBe(message.timestamp);
  });

  it('is idempotent on draft.id: a replay returns the original sequence and inserts nothing', () => {
    const draft = { id: 'dup', kind: 'chat', content: '{"text":"same"}' };
    const first = ops.writeMessageOut(draft);
    expect(ops.writeMessageOut(draft)).toBe(first);
    expect(outboundRows('SELECT * FROM messages_out')).toHaveLength(1);
    ops.writeMessageOut({ id: 'other', kind: 'chat', content: 'y' });
    expect(ops.writeMessageOut(draft)).toBe(first);
    expect(outboundRows('SELECT * FROM messages_out')).toHaveLength(2);
  });

  it('rejects an invalid draft', () => {
    expect(() => ops.writeMessageOut({ id: 'a', content: 'x' } as never)).toThrow();
    expect(() => ops.writeMessageOut({ id: 'a', kind: 'chat', content: 'x', bogus: 1 } as never)).toThrow();
  });

  it('getUndeliveredMessages hides rows whose deliver_after is in the future', () => {
    ops.writeMessageOut({ id: 'now', kind: 'chat', content: 'x' });
    ops.writeMessageOut({
      id: 'later',
      kind: 'chat',
      content: 'x',
      deliverAfter: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(ops.getUndeliveredMessages().map((m) => m.id)).toEqual(['now']);
  });
});

describe('sequence lookups and delivery status', () => {
  it('getMessageIdBySeq resolves inbound, outbound and delivered platform ids', () => {
    hostInsert(key, { id: 'in1' }); // seq 2
    const seq = ops.writeMessageOut({ id: 'out1', kind: 'chat', content: 'x' }); // seq 3
    expect(ops.getMessageIdBySeq(2)).toBe('in1');
    expect(ops.getMessageIdBySeq(seq)).toBe('out1');
    expect(ops.getMessageIdBySeq(99)).toBeNull();
    inboundExec((db) =>
      db
        .prepare(
          "INSERT INTO delivered (message_out_id, platform_message_id, status, delivered_at) VALUES ('out1', 'tg-555', 'delivered', ?)",
        )
        .run(new Date().toISOString()),
    );
    expect(ops.getMessageIdBySeq(seq)).toBe('tg-555');
  });

  it('getRoutingBySeq reads inbound first, then outbound, else null', () => {
    hostInsert(key, { id: 'in1', channelType: 'tg', platformId: 'chat-in', threadId: 'th-in' }); // seq 2
    const seq = ops.writeMessageOut({
      id: 'out1',
      kind: 'chat',
      content: 'x',
      channelType: 'slack',
      platformId: 'chat-out',
    });
    expect(ops.getRoutingBySeq(2)).toEqual({ channelType: 'tg', platformId: 'chat-in', threadId: 'th-in' });
    expect(ops.getRoutingBySeq(seq)).toEqual({ channelType: 'slack', platformId: 'chat-out', threadId: null });
    expect(ops.getRoutingBySeq(1000)).toBeNull();
  });

  it('getDeliveryStatus is null until delivered, then delivered or failed', () => {
    expect(ops.getDeliveryStatus('out1')).toBeNull();
    inboundExec((db) => {
      const insert = db.prepare(
        'INSERT INTO delivered (message_out_id, platform_message_id, status, delivered_at) VALUES (?, NULL, ?, ?)',
      );
      insert.run('out1', 'delivered', new Date().toISOString());
      insert.run('out2', 'failed', new Date().toISOString());
    });
    expect(ops.getDeliveryStatus('out1')).toBe('delivered');
    expect(ops.getDeliveryStatus('out2')).toBe('failed');
  });
});

describe('state and container state', () => {
  it('set / get / replace / delete', () => {
    expect(ops.getState('k')).toBeUndefined();
    ops.setState('k', 'v1');
    const first = ops.getState('k');
    expect(first?.value).toBe('v1');
    expect(new Date(first!.updatedAt).toISOString()).toBe(first!.updatedAt);
    ops.setState('k', 'v2');
    expect(ops.getState('k')?.value).toBe('v2');
    ops.deleteState('k');
    expect(ops.getState('k')).toBeUndefined();
  });

  it('normalises legacy SQLite-format timestamps like the runner', () => {
    const db = new Database(outboundDbPath(key.agentGroupId, key.sessionId));
    db.prepare(
      "INSERT INTO session_state (key, value, updated_at) VALUES ('legacy', 'x', '2026-03-04 05:06:07')",
    ).run();
    db.close();
    expect(ops.getState('legacy')?.updatedAt).toBe('2026-03-04T05:06:07.000Z');
    expect(sqliteTimestamp('2026-03-04 05:06:07')).toBe('2026-03-04T05:06:07.000Z');
    expect(sqliteTimestamp('not a date')).toBe('not a date');
  });

  it('setContainerToolInFlight / clearContainerToolInFlight upsert the single container_state row', () => {
    ops.setContainerToolInFlight('Bash', 120000);
    let [row] = outboundRows<{
      id: number;
      current_tool: string | null;
      tool_declared_timeout_ms: number | null;
      tool_started_at: string | null;
    }>('SELECT * FROM container_state');
    expect(row).toMatchObject({ id: 1, current_tool: 'Bash', tool_declared_timeout_ms: 120000 });
    expect(row.tool_started_at).toBeTruthy();

    ops.setContainerToolInFlight('Read', null);
    [row] = outboundRows('SELECT * FROM container_state');
    expect(row).toMatchObject({ current_tool: 'Read', tool_declared_timeout_ms: null });

    ops.setContainerToolInFlight('Bash', -5); // invalid timeout is dropped, as in the runner
    [row] = outboundRows('SELECT * FROM container_state');
    expect(row.tool_declared_timeout_ms).toBeNull();

    ops.clearContainerToolInFlight();
    const rows = outboundRows<{
      current_tool: string | null;
      tool_declared_timeout_ms: number | null;
      tool_started_at: string | null;
    }>('SELECT * FROM container_state');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ current_tool: null, tool_declared_timeout_ms: null, tool_started_at: null });
  });
});

describe('session availability', () => {
  it('throws SessionUnavailableError when the session DBs do not exist', () => {
    const missing = createSessionOperations({ agentGroupId: 'ag-none', sessionId: 'sess-none' });
    expect(() => missing.getPendingMessages(1, true)).toThrow(SessionUnavailableError);
    expect(() => missing.setState('k', 'v')).toThrow(SessionUnavailableError);
  });
});
