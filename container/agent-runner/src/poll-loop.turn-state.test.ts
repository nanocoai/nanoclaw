/**
 * The runner reports its own turn state to container_state so the host's
 * typing indicator can follow it: 'working' while a turn runs (re-marked so
 * updated_at keeps moving), 'idle' the moment it returns to waiting — even
 * when the turn produced no message.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { MockProvider } from './providers/mock.js';
import { runPollLoop } from './poll-loop.js';
import type { AgentQuery, ProviderEvent, QueryInput } from './providers/types.js';

const CONTRACT = { textDelivery: 'mid-turn-complete', commands: { formatting: 'xml' } } as const;

beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('slack-test', 'Slack Test', 'channel', 'slack', 'C123', NULL)`,
    )
    .run();
});
afterEach(() => closeSessionDb());

function insertMessage(id: string, text: string, threadId: string) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', datetime('now'), 'pending', 'C123', 'slack', ?, ?)`,
    )
    .run(id, threadId, JSON.stringify({ sender: 'Alice', text }));
}

function readTurn(): string | null {
  const row = getOutboundDb().prepare('SELECT turn FROM container_state WHERE id = 1').get() as
    | { turn: string | null }
    | undefined;
  return row?.turn ?? null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms: number) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout');
    await sleep(25);
  }
}

/** Streams a partial block, then holds the turn open until release(). */
class HoldingProvider extends MockProvider {
  release: () => void = () => {};
  private gate = new Promise<void>((r) => (this.release = r));
  query(_input: QueryInput): AgentQuery {
    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let aborted = false;
    const gate = this.gate;
    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'init', continuation: 'hold-session' };
        yield { type: 'text', text: '<message to="slack-test">partial A</message>' };
        await gate;
        yield { type: 'text', text: '<message to="slack-test">done A</message>' };
        yield { type: 'result', text: '<message to="slack-test">done A</message>' };
        while (!aborted) {
          if (pending.length > 0) {
            pending.shift();
            yield { type: 'text', text: '<message to="slack-test">done B</message>' };
            yield { type: 'result', text: '<message to="slack-test">done B</message>' };
            continue;
          }
          await new Promise<void>((r) => (waiting = r));
          waiting = null;
        }
      },
    };
    return {
      push: (m: string) => {
        pending.push(m);
        waiting?.();
      },
      end: () => {},
      abort: () => {
        aborted = true;
        waiting?.();
      },
      events,
    };
  }
}

describe('runner turn state', () => {
  it('stays working across a two-message turn and reports idle once it returns to waiting', async () => {
    insertMessage('m-a', 'first question', 'thread-A');
    const provider = new HoldingProvider();
    const controller = new AbortController();
    const loop = runPollLoop({
      provider,
      providerContract: CONTRACT,
      providerName: 'mock',
      cwd: '/tmp',
      signal: controller.signal,
    });

    // Turn opens working while the provider holds the stream.
    await waitFor(() => readTurn() === 'working', 3000);
    await waitFor(() => getUndeliveredMessages().length >= 1, 3000); // "partial A" streamed

    // A second message arrives mid-turn — the turn is still working.
    insertMessage('m-b', 'second question', 'thread-B');
    await sleep(700); // follow-up poller pushes m-b into the running turn
    expect(readTurn()).toBe('working');

    // Release: both turns answer, then the loop returns to waiting → idle.
    provider.release();
    await waitFor(() => getUndeliveredMessages().length >= 2, 5000);
    await waitFor(() => readTurn() === 'idle', 3000);

    controller.abort();
    await loop.catch(() => {});
    expect(readTurn()).toBe('idle');
  });

  it('reports idle after a quiet turn that delivers no message', async () => {
    insertMessage('m-a', 'no reply needed', 'thread-A');
    // Empty response: the turn runs but writes nothing user-facing.
    const provider = new MockProvider({}, () => '');
    const controller = new AbortController();
    const loop = runPollLoop({
      provider,
      providerContract: CONTRACT,
      providerName: 'mock',
      cwd: '/tmp',
      signal: controller.signal,
    });

    await waitFor(() => readTurn() === 'idle', 4000);
    expect(getUndeliveredMessages()).toHaveLength(0);

    controller.abort();
    await loop.catch(() => {});
  });
});
