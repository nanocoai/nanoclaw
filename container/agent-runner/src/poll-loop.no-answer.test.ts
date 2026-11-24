import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getUndeliveredMessages } from './db/messages-out.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { runPollLoop } from './poll-loop.js';
import type { AgentProvider, ProviderEvent } from './providers/types.js';

// The no-answer nudge (#4564) through the real poll loop, where follow-ups
// arrive from the inbound DB and queue behind the turn in flight.

const CONTRACT = { textDelivery: 'mid-turn-complete', commands: { formatting: 'xml' } } as const;

function insertMessage(id: string, threadId: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in
       (id, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', ?, 'pending', 1, 'channel-1', 'slack', ?, ?)`,
    )
    .run(id, new Date().toISOString(), threadId, JSON.stringify({ text: id, prompt: id }));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for provider progress');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function noAnswerNudges(pushes: string[]): string[] {
  return pushes.filter((p) => p.includes('ended without a reply'));
}

beforeEach(() => {
  initTestSessionDb();
  getInboundDb().exec(
    `INSERT INTO destinations (name, display_name, type, channel_type, platform_id)
     VALUES ('main', 'Main', 'channel', 'slack', 'channel-1')`,
  );
});
afterEach(() => closeSessionDb());

async function run(events: (pushes: string[]) => AsyncGenerator<ProviderEvent>): Promise<string[]> {
  insertMessage('request-a', 'thread-a');
  const controller = new AbortController();
  const pushes: string[] = [];
  const provider: AgentProvider = {
    registerMemorySessionHook: () => {},
    isSessionInvalid: () => false,
    query: () => ({
      events: (async function* () {
        yield* events(pushes);
        controller.abort();
      })(),
      push: (prompt) => pushes.push(prompt),
      end: () => {},
      abort: () => {},
    }),
  };
  await runPollLoop({
    provider,
    providerContract: CONTRACT,
    providerName: 'mock',
    cwd: '/workspace/agent',
    signal: controller.signal,
  });
  return pushes;
}

describe('no-answer nudge in the poll loop', () => {
  it('an empty turn with nothing queued gets the nudge', async () => {
    const pushes = await run(async function* (pushes) {
      yield { type: 'result', text: '' };
      await waitFor(() => pushes.length === 1);
      yield { type: 'text', text: '<message to="main">Answered A</message>' };
      yield { type: 'result', text: '' };
    });
    expect(noAnswerNudges(pushes)).toHaveLength(1);
    const replies = getUndeliveredMessages().filter((row) => row.kind === 'chat');
    expect(replies.map((row) => [JSON.parse(row.content).text, row.thread_id])).toEqual([['Answered A', 'thread-a']]);
  });

  it('an empty turn with a follow-up queued gets no nudge, so no retry lands behind it', async () => {
    const pushes = await run(async function* (pushes) {
      insertMessage('request-b', 'thread-b');
      await waitFor(() => pushes.length === 1);
      // A ends empty while B is queued; B's turn then answers.
      yield { type: 'result', text: '' };
      yield { type: 'text', text: '<message to="main">Answered B</message>' };
      yield { type: 'result', text: '' };
    });
    expect(noAnswerNudges(pushes)).toEqual([]);
    expect(pushes).toHaveLength(1);
  });
});
