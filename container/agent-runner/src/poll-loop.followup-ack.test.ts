/**
 * #4558: a follow-up pushed into an open query stays 'processing' until the
 * turn that answers it ends. Acking it completed at push time meant a
 * container that died before answering (an idle stop racing the very message
 * that woke it) left the message completed with no reply and nothing to retry.
 */
import { afterEach, beforeEach, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { processQuery } from './poll-loop.js';
import type { ProviderEvent } from './providers/types.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

const ROUTING = { platformId: 'chan-1', channelType: 'discord', threadId: null, inReplyTo: 'm1' };

function insertChat(id: string, text: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, trigger, content)
       VALUES (?, 'chat', datetime('now'), 'pending', 1, ?)`,
    )
    .run(id, JSON.stringify({ sender: 'A', text }));
}

function ackStatus(id: string): string | undefined {
  const row = getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(id) as
    { status: string } | undefined;
  return row?.status;
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function controlledQuery() {
  const pushes: string[] = [];
  const queue: ProviderEvent[] = [];
  let ended = false;
  let wake: (() => void) | undefined;
  const emit = (event: ProviderEvent | 'end') => {
    if (event === 'end') ended = true;
    else queue.push(event);
    wake?.();
  };
  async function* events(): AsyncGenerator<ProviderEvent> {
    while (true) {
      while (queue.length > 0) yield queue.shift()!;
      if (ended) return;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  }
  return {
    pushes,
    emit,
    query: { push: (m: string) => void pushes.push(m), end: () => {}, events: events(), abort: () => {} },
  };
}

it('keeps an idle-time follow-up processing until its turn produces a result', async () => {
  const { query, emit, pushes } = controlledQuery();
  const run = processQuery(query, ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

  emit({ type: 'init', continuation: 'sess-1' });
  emit({ type: 'result', text: '' });
  // Query parked between turns; a new message arrives.
  insertChat('m2', 'are you there?');
  await waitFor(() => pushes.length === 1);

  // Claimed, but not answered yet: a container death here must leave it retryable.
  expect(ackStatus('m2')).toBe('processing');

  emit({ type: 'result', text: '' });
  await waitFor(() => ackStatus('m2') === 'completed');

  emit('end');
  await run;
});

it('keeps a follow-up queued behind an in-flight turn processing until its own result', async () => {
  const { query, emit, pushes } = controlledQuery();
  const run = processQuery(query, ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

  emit({ type: 'init', continuation: 'sess-1' });
  // m1's turn is still in flight when m2 is pushed.
  insertChat('m2', 'one more thing');
  await waitFor(() => pushes.length === 1);
  expect(ackStatus('m2')).toBe('processing');

  emit({ type: 'result', text: '' }); // answers m1 only
  await waitFor(() => ackStatus('m1') === 'completed');
  expect(ackStatus('m2')).toBe('processing');

  emit({ type: 'result', text: '' }); // answers m2
  await waitFor(() => ackStatus('m2') === 'completed');

  emit('end');
  await run;
});

it('acks a pushed follow-up completed when the stream ends before its result', async () => {
  const { query, emit, pushes } = controlledQuery();
  const run = processQuery(query, ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

  emit({ type: 'init', continuation: 'sess-1' });
  emit({ type: 'result', text: '' });
  insertChat('m2', 'late');
  await waitFor(() => pushes.length === 1);

  emit('end');
  await run;
  expect(ackStatus('m2')).toBe('completed');
});
