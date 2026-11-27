/**
 * Turn traces through the real capability barrel and the real turn-hook
 * dispatch the poll loop calls. Goes red if the barrel line is deleted, if
 * the turn-hook points drift, or if the outbound row stops matching what
 * the host's `turn_trace` action reads.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import '../index.js';
import type { MessageInRow } from '../../db/messages-in.js';
import { getUndeliveredMessages } from '../../db/messages-out.js';
import type { RoutingContext } from '../../formatter.js';
import { closeSessionDb, initTestSessionDb } from '../../mailbox/sqlite/connection.js';
import { runBeforeTurn, runOnError, runProviderEvent } from '../../turn-hooks.js';
import { MAX_STEPS, recordToolEnd, recordToolStart, resetTurnTraces, type TurnTracePayload } from './recorder.js';

function row(id: string, text: string): MessageInRow {
  return {
    id,
    seq: 2,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    status: 'processing',
    process_after: null,
    recurrence: null,
    series_id: null,
    tries: 0,
    trigger: 1,
    platform_id: 'chan-1',
    channel_type: 'test',
    thread_id: null,
    content: JSON.stringify({ text }),
    source_session_id: null,
    on_wake: 0,
  };
}

function routingFor(id: string): RoutingContext {
  return { platformId: 'chan-1', channelType: 'test', threadId: null, inReplyTo: id, taskRun: false };
}

async function traces(): Promise<TurnTracePayload[]> {
  // The recorder writes fire-and-forget; let the pending write settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return getUndeliveredMessages()
    .filter((m) => m.kind === 'system')
    .map((m) => JSON.parse(m.content) as TurnTracePayload)
    .filter((c) => c.action === 'turn_trace');
}

let tmp: string;
let marker: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-traces-'));
  marker = path.join(tmp, 'turn-traces.enabled');
  fs.writeFileSync(marker, '');
  initTestSessionDb();
  resetTurnTraces(marker);
});

afterEach(() => {
  resetTurnTraces();
  closeSessionDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('turn traces', () => {
  it('records nothing for a group that has not opted in', async () => {
    fs.rmSync(marker);
    const routing = routingFor('m-1');
    await runBeforeTurn({ messages: [row('m-1', 'hello')], routing, followUp: false });
    runProviderEvent({ type: 'result', text: 'done' }, routing);

    expect(await traces()).toEqual([]);
  });

  it('writes one turn_trace system row per answered batch', async () => {
    const routing = routingFor('m-1');
    await runBeforeTurn({ messages: [row('m-1', 'hello')], routing, followUp: false });
    runProviderEvent({ type: 'activity' }, routing);
    recordToolStart('tu-1', 'Bash', { command: 'ls' });
    recordToolEnd('tu-1', 'a.txt', false, 12);
    runProviderEvent({ type: 'text', text: 'thinking out loud' }, routing);
    runProviderEvent({ type: 'result', text: 'done' }, routing);

    const [trace, ...rest] = await traces();
    expect(rest).toHaveLength(0);
    expect(trace.turn_id).toBe('m-1');
    expect(trace.message_ids).toEqual(['m-1']);
    expect(trace.status).toBe('ok');
    expect(trace.input).toContain('hello');
    expect(trace.output).toBe('done');
    expect(Date.parse(trace.ended_at)).toBeGreaterThanOrEqual(Date.parse(trace.started_at));
    expect(trace.steps).toEqual([
      expect.objectContaining({ type: 'tool', tool_use_id: 'tu-1', name: 'Bash', output: 'a.txt', duration_ms: 12 }),
      expect.objectContaining({ type: 'text', text: 'thinking out loud' }),
    ]);
  });

  it('gives a follow-up pushed into a live query its own trace', async () => {
    const first = routingFor('m-1');
    const second = routingFor('m-2');
    await runBeforeTurn({ messages: [row('m-1', 'one')], routing: first, followUp: false });
    await runBeforeTurn({ messages: [row('m-2', 'two')], routing: second, followUp: true });
    runProviderEvent({ type: 'result', text: 'answer one' }, first);
    runProviderEvent({ type: 'activity' }, second);
    recordToolStart('tu-2', 'Read', { file_path: '/tmp/x' });
    runProviderEvent({ type: 'result', text: 'answer two' }, second);
    // A corrective retry of an already-closed turn records nothing.
    runProviderEvent({ type: 'result', text: 'retry' }, second);

    const all = await traces();
    expect(all.map((t) => [t.turn_id, t.output])).toEqual([
      ['m-1', 'answer one'],
      ['m-2', 'answer two'],
    ]);
    expect(all[0].steps).toHaveLength(0);
    expect(all[1].steps).toEqual([expect.objectContaining({ name: 'Read', output: null })]);
  });

  it('closes open turns as errors when the query throws', async () => {
    const routing = routingFor('m-1');
    await runBeforeTurn({ messages: [row('m-1', 'hello')], routing, followUp: false });
    await runOnError(new Error('provider exploded'), { messages: [], routing, followUp: false });

    const [trace] = await traces();
    expect(trace.status).toBe('error');
    expect(trace.error).toBe('provider exploded');
  });

  it('marks a turn left open by a previous query as incomplete', async () => {
    await runBeforeTurn({ messages: [row('m-1', 'one')], routing: routingFor('m-1'), followUp: false });
    await runBeforeTurn({ messages: [row('m-2', 'two')], routing: routingFor('m-2'), followUp: false });

    const [trace] = await traces();
    expect(trace.turn_id).toBe('m-1');
    expect(trace.status).toBe('incomplete');
  });

  it('bounds the number of recorded steps', async () => {
    const routing = routingFor('m-1');
    await runBeforeTurn({ messages: [row('m-1', 'hello')], routing, followUp: false });
    for (let i = 0; i < MAX_STEPS + 5; i++) runProviderEvent({ type: 'text', text: `t${i}` }, routing);
    runProviderEvent({ type: 'result', text: null }, routing);

    const [trace] = await traces();
    expect(trace.steps).toHaveLength(MAX_STEPS);
    expect(trace.steps_dropped).toBe(5);
  });
});
