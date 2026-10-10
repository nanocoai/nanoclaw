import { afterEach, beforeEach, expect, it } from 'bun:test';
import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getCurrentReplyRoute } from './db/session-state.js';
import { processQuery } from './poll-loop.js';
import type { RoutingContext } from './formatter.js';
import type { AgentQuery, ProviderEvent, ProviderExchange } from './providers/types.js';

beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations
    (name, display_name, type, channel_type, platform_id, agent_group_id)
    VALUES ('slack-test', 'Slack Test', 'channel', 'slack', 'C123', NULL)`,
    )
    .run();
});
afterEach(closeSessionDb);
const route = (id: string, taskRun = false): RoutingContext => ({
  platformId: 'C123',
  channelType: 'slack',
  threadId: `thread-${id}`,
  inReplyTo: `m-${id}`,
  taskRun,
});
function insert(id: string, kind = 'chat') {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in
    (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
    VALUES (?, ?, ?, 'pending', 'C123', 'slack', ?, ?)`,
    )
    .run(
      `m-${id}`,
      kind,
      new Date().toISOString(),
      `thread-${id}`,
      JSON.stringify({ sender: 'Alice', text: `question ${id}`, prompt: `question ${id}` }),
    );
}
async function waitFor(test: () => boolean) {
  const until = Date.now() + 2500;
  while (!test()) {
    if (Date.now() > until) throw new Error('follow-up was not pushed');
    await Bun.sleep(10);
  }
}
const block = (text: string) => `<message to="slack-test">${text}</message>`;

it('routes B then the retry of A in provider FIFO order, with matching exchange prompts', async () => {
  const pushed: string[] = [];
  const stamps: unknown[] = [];
  const exchanges: ProviderExchange[] = [];
  const query: AgentQuery = {
    push: (prompt) => {
      pushed.push(prompt);
    },
    end() {},
    abort() {},
    events: {
      async *[Symbol.asyncIterator](): AsyncGenerator<ProviderEvent> {
        insert('B');
        await waitFor(() => pushed.length === 1);
        yield { type: 'result', text: 'answer A without wrapping' };
        expect(pushed).toHaveLength(2);
        expect(pushed[0]).toContain('question B');
        expect(pushed[1]).toContain('Please re-send');
        for (const prompt of pushed.slice()) {
          const id = prompt.includes('question B') ? 'B' : 'A';
          stamps.push(getCurrentReplyRoute());
          yield { type: 'text', text: block(`answer ${id}`) };
          yield { type: 'result', text: block(`answer ${id}`) };
        }
      },
    },
  };
  await processQuery(query, route('A'), [], 'mock', (e) => exchanges.push(e), 'question A', undefined, true);
  expect(getUndeliveredMessages().map((m) => [JSON.parse(m.content).text, m.thread_id, m.in_reply_to])).toEqual([
    ['answer B', 'thread-B', 'm-B'],
    ['answer A', 'thread-A', 'm-A'],
  ]);
  expect(stamps).toEqual(
    ['B', 'A'].map((id) => ({
      inReplyTo: `m-${id}`,
      channelType: 'slack',
      platformId: 'C123',
      threadId: `thread-${id}`,
    })),
  );
  expect(exchanges.map((e) => (e.prompt.includes('question B') ? 'B' : 'A'))).toEqual(['A', 'B', 'A']);
});

it('adopts task delivery and writes a task log when an empty warm query receives a task', async () => {
  const pushed: string[] = [];
  const query: AgentQuery = {
    push: (p) => {
      pushed.push(p);
    },
    end() {},
    abort() {},
    events: {
      async *[Symbol.asyncIterator](): AsyncGenerator<ProviderEvent> {
        insert('T', 'task');
        await waitFor(() => pushed.length === 1);
        yield { type: 'result', text: 'Scheduled check completed.' };
      },
    },
  };
  await processQuery(query, route('warm'), [], 'mock', undefined, '', undefined);
  expect(getUndeliveredMessages().map((m) => [m.kind, JSON.parse(m.content).text])).toEqual([
    ['task_log', 'Scheduled check completed.'],
  ]);
  expect(pushed).toHaveLength(1);
});

it('restores chat delivery when a task query receives a chat turn', async () => {
  const pushed: string[] = [];
  const query: AgentQuery = {
    push: (p) => {
      pushed.push(p);
    },
    end() {},
    abort() {},
    events: {
      async *[Symbol.asyncIterator](): AsyncGenerator<ProviderEvent> {
        yield { type: 'result', text: 'Task finished.' };
        insert('B');
        await waitFor(() => pushed.length === 1);
        yield { type: 'text', text: block('answer B') };
        yield { type: 'result', text: block('answer B') };
      },
    },
  };
  await processQuery(query, route('T', true), [], 'mock', undefined, 'task T', undefined, true);
  expect(getUndeliveredMessages().map((m) => [m.kind, JSON.parse(m.content).text, m.thread_id])).toEqual([
    ['task_log', 'Task finished.', null],
    ['chat', 'answer B', 'thread-B'],
  ]);
  expect(pushed).toHaveLength(1);
});
