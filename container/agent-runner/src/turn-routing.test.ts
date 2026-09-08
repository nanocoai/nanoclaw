/**
 * Where a reply goes is a property of the turn, not the query. The query stays
 * open across turns, so later messages are pushed into it as follow-ups; each
 * must be answered in its own thread, while an answer already streaming keeps
 * the destination it started with.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { MockProvider } from './providers/mock.js';
import { runPollLoop } from './poll-loop.js';
import { getCurrentReplyRoute } from './db/session-state.js';

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms: number) {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error('waitFor timeout');
    await sleep(50);
  }
}

describe('turn routing — a later turn from another thread on the same open query', () => {
  it('replies in the thread of the later message, not the first batch', async () => {
    insertMessage('m-a', 'first question', 'thread-A');
    const provider = new MockProvider({}, () => '<message to="slack-test">answer</message>');
    const controller = new AbortController();
    const loop = runPollLoop({
      provider,
      providerContract: CONTRACT,
      providerName: 'mock',
      cwd: '/tmp',
      signal: controller.signal,
    });

    // Turn 1 completes: one reply, in thread-A.
    await waitFor(() => getUndeliveredMessages().length >= 1, 3000);
    await sleep(300); // query stays open; the turn is over
    expect(getUndeliveredMessages()[0].thread_id).toBe('thread-A');

    // Turn 2: a NEW message from another thread arrives after the answer finished.
    insertMessage('m-b', 'second question', 'thread-B');
    await waitFor(() => getUndeliveredMessages().length >= 2, 5000);
    // The stamp the MCP tools read follows the turn too.
    expect(getCurrentReplyRoute()).toEqual({
      inReplyTo: 'm-b',
      channelType: 'slack',
      platformId: 'C123',
      threadId: 'thread-B',
    });
    controller.abort();
    await loop.catch(() => {});

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(2);
    expect(out[1].in_reply_to).toBe('m-b');
    expect(out[1].thread_id).toBe('thread-B');
  });
});

import type { AgentQuery, ProviderEvent, QueryInput } from './providers/types.js';

/** Turn 1 streams a partial block, then stalls until release(); later pushes are answered after it. */
class StallingProvider extends MockProvider {
  release: () => void = () => {};
  private released = new Promise<void>((r) => (this.release = r));
  query(input: QueryInput): AgentQuery {
    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let aborted = false;
    const released = this.released;
    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'init', continuation: 'stall-session' };
        yield { type: 'text', text: '<message to="slack-test">partial A</message>' };
        await released;
        yield { type: 'text', text: '<message to="slack-test">done A</message>' };
        yield { type: 'result', text: '<message to="slack-test">done A</message>' };
        while (!aborted) {
          if (pending.length > 0) {
            const msg = pending.shift()!;
            const text = `<message to="slack-test">done ${msg.includes('second') ? 'B' : '?'}</message>`;
            yield { type: 'text', text };
            yield { type: 'result', text };
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

describe('turn routing — a message arriving while the answer is still running', () => {
  it('keeps the in-flight answer in its own thread and answers the new message in its thread', async () => {
    insertMessage('m-a', 'first question', 'thread-A');
    const provider = new StallingProvider();
    const controller = new AbortController();
    const loop = runPollLoop({
      provider,
      providerContract: CONTRACT,
      providerName: 'mock',
      cwd: '/tmp',
      signal: controller.signal,
    });

    await waitFor(() => getUndeliveredMessages().length >= 1, 3000); // "partial A" streamed, turn still open
    insertMessage('m-b', 'second question', 'thread-B');
    await sleep(700); // follow-up poller pushes m-b into the running turn
    provider.release();
    await waitFor(() => getUndeliveredMessages().length >= 3, 5000);
    controller.abort();
    await loop.catch(() => {});

    const out = getUndeliveredMessages().map((m) => [JSON.parse(m.content).text, m.thread_id, m.in_reply_to]);
    expect(out).toEqual([
      ['partial A', 'thread-A', 'm-a'],
      ['done A', 'thread-A', 'm-a'],
      ['done B', 'thread-B', 'm-b'],
    ]);
  });
});

describe('reply stamp — startup', () => {
  it('clears a stamp left behind by a killed container', async () => {
    // A previous container died mid-batch (SIGKILL skips the clearing finally).
    getOutboundDb()
      .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run(
        'current_reply_route',
        JSON.stringify({ inReplyTo: 'dead-1', channelType: 'slack', platformId: 'C123', threadId: 'thread-dead' }),
        new Date().toISOString(),
      );
    expect(getCurrentReplyRoute()?.inReplyTo).toBe('dead-1');

    const provider = new MockProvider({}, () => '<message to="slack-test">answer</message>');
    const controller = new AbortController();
    const loop = runPollLoop({
      provider,
      providerContract: CONTRACT,
      providerName: 'mock',
      cwd: '/tmp',
      signal: controller.signal,
    });
    await waitFor(() => getCurrentReplyRoute() === null, 3000);
    controller.abort();
    await loop.catch(() => {});
    expect(getCurrentReplyRoute()).toBeNull();
  });
});

/** Answers turn 1, answers one pushed follow-up, then the stream fails. */
class FailingAfterFollowUpProvider extends MockProvider {
  query(_input: QueryInput): AgentQuery {
    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let aborted = false;
    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'init', continuation: 'fail-session' };
        yield { type: 'text', text: '<message to="slack-test">done A</message>' };
        yield { type: 'result', text: '<message to="slack-test">done A</message>' };
        while (!aborted) {
          if (pending.length > 0) {
            pending.shift();
            yield { type: 'text', text: '<message to="slack-test">done B</message>' };
            yield { type: 'result', text: '<message to="slack-test">done B</message>' };
            throw new Error('stream broke');
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

describe('turn routing — a query error after later turns', () => {
  it('addresses the error notice to the batch that opened the query, not the last turn', async () => {
    insertMessage('m-a', 'first question', 'thread-A');
    const provider = new FailingAfterFollowUpProvider();
    const controller = new AbortController();
    const loop = runPollLoop({
      provider,
      providerContract: CONTRACT,
      providerName: 'mock',
      cwd: '/tmp',
      signal: controller.signal,
    });

    await waitFor(() => getUndeliveredMessages().length >= 1, 3000);
    await sleep(300); // turn 1 over, query open
    insertMessage('m-b', 'second question', 'thread-B');
    await waitFor(() => getUndeliveredMessages().length >= 3, 5000); // done B + error notice
    controller.abort();
    await loop.catch(() => {});

    const out = getUndeliveredMessages().map((m) => [JSON.parse(m.content).text, m.thread_id]);
    expect(out).toEqual([
      ['done A', 'thread-A'],
      ['done B', 'thread-B'],
      ['Error: stream broke', 'thread-A'],
    ]);
  });
});
