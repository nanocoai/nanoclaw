import { afterEach, beforeEach, expect, it } from 'bun:test';

import { getUndeliveredMessages } from './db/messages-out.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { processQuery } from './poll-loop.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';

const ROUTING = { platformId: 'chan-1', channelType: 'discord', threadId: null, inReplyTo: 'm1', taskRun: false };

beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('main', 'main', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});
afterEach(() => closeSessionDb());

function insertMessage(id: string, text: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, process_after, trigger, on_wake, platform_id, channel_type, content)
       VALUES (?, 'chat', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'pending', NULL, 1, 0, 'chan-1', 'discord', ?)`,
    )
    .run(id, JSON.stringify({ sender: 'User', text }));
}

async function until(pushes: string[], n: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (pushes.length < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  if (pushes.length < n) throw new Error('follow-up was not pushed');
}

async function run(folded: boolean): Promise<Record<string, string | null>> {
  const pushes: string[] = [];
  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'init', continuation: 's1' };
    insertMessage('m2', 'second question'); // arrives while m1's turn runs
    await until(pushes, 1);
    if (folded) {
      // The provider answers the waiting inputs m1 and m2 together in one turn
      // and reports BOTH input ids on the result.
      yield { type: 'text', text: '<message to="main">answer to m1 and m2</message>' };
      yield { type: 'result', text: '', answered: ['m1', 'm2'] };
    } else {
      yield { type: 'text', text: '<message to="main">answer to m1</message>' };
      yield { type: 'result', text: '', answered: ['m1'] };
      yield { type: 'text', text: '<message to="main">answer to m2</message>' };
      yield { type: 'result', text: '', answered: ['m2'] };
    }
    insertMessage('m3', 'third question'); // arrives later, gets its own turn
    await until(pushes, 2);
    yield { type: 'text', text: '<message to="main">answer to m3</message>' };
    yield { type: 'result', text: '', answered: ['m3'] };
  }
  const query: AgentQuery = {
    push: (m) => void pushes.push(m),
    pushWithId: (m) => void pushes.push(m),
    end: () => {},
    events: events(),
    abort: () => {},
  };
  await processQuery(query, ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);
  return Object.fromEntries(
    getUndeliveredMessages().map((r) => [JSON.parse(r.content).text as string, r.in_reply_to ?? null]),
  );
}

it('one turn per follow-up: each answer is stamped with its own message', async () => {
  expect(await run(false)).toEqual({ 'answer to m1': 'm1', 'answer to m2': 'm2', 'answer to m3': 'm3' });
});

it('a follow-up folded into the running turn: the next answer is still stamped with its own message', async () => {
  expect((await run(true))['answer to m3']).toBe('m3');
});
