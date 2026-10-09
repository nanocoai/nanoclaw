import { expect, test } from 'bun:test';

import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { runPollLoop } from './poll-loop.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(cond: () => boolean, ms: number) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout');
    await sleep(50);
  }
}

class HoldingProvider {
  prompts: string[] = [];
  pushes: string[] = [];
  release: () => void = () => {};
  private gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  private calls = 0;

  registerMemorySessionHook(): void {}
  isSessionInvalid(): boolean {
    return false;
  }

  query(input: { prompt: string }) {
    this.prompts.push(input.prompt);
    this.calls += 1;
    if (this.calls > 1) {
      return {
        push: () => {},
        end: () => {},
        abort: () => {},
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: 'init', continuation: 'fresh' };
            yield { type: 'result', text: '<message to="slack-test">fresh</message>' };
          },
        },
      };
    }
    const gate = this.gate;
    const pushes = this.pushes;
    let ended = false;
    const release = () => this.release();
    return {
      push: (message: string) => {
        pushes.push(message);
      },
      end: () => {
        ended = true;
        release();
      },
      abort: () => {
        ended = true;
        release();
      },
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: 'init', continuation: 'hold' };
          await gate;
          if (ended) return;
          yield { type: 'result', text: '<message to="slack-test">done</message>' };
        },
      },
    };
  }
}

test('defer-until-fresh-query leaves an ordinary follow-up pending and unacknowledged', async () => {
  initTestSessionDb();
  try {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-test', 'Slack Test', 'channel', 'slack', 'C123', NULL)`,
      )
      .run();
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content, trigger)
         VALUES ('m-first', 'chat', datetime('now'), 'pending', 'C123', 'slack', 'thread-A', ?, 1)`,
      )
      .run(JSON.stringify({ sender: 'Alice', text: 'first question' }));

    const provider = new HoldingProvider();
    const controller = new AbortController();
    const loop = runPollLoop({
      provider,
      providerContract: {
        textDelivery: 'result',
        commands: { formatting: 'xml' },
        turn: { ordinaryFollowUps: 'defer-until-fresh-query' },
      },
      providerName: 'mock',
      cwd: process.cwd(),
      signal: controller.signal,
    });

    await waitFor(() => provider.prompts.length >= 1, 4000);
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content, trigger)
         VALUES ('m-follow', 'chat', datetime('now'), 'pending', 'C123', 'slack', 'thread-A', ?, 1)`,
      )
      .run(JSON.stringify({ sender: 'Alice', text: 'follow-up while busy' }));
    await sleep(1200);

    expect(provider.pushes).toHaveLength(0);
    const ack = getOutboundDb()
      .prepare('SELECT status FROM processing_ack WHERE message_id = ?')
      .get('m-follow') as { status: string } | null;
    expect(ack).toBeNull();
    const row = getInboundDb().prepare(`SELECT status FROM messages_in WHERE id = 'm-follow'`).get() as {
      status: string;
    };
    expect(row.status).toBe('pending');

    provider.release();
    await waitFor(() => provider.prompts.length >= 2, 4000);
    expect(provider.prompts[1]).toContain('follow-up while busy');

    controller.abort();
    provider.release();
    await Promise.race([loop.catch(() => {}), sleep(2000)]);
  } finally {
    closeSessionDb();
  }
}, 15000);
