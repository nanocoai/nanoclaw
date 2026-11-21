/**
 * Accumulated context rows (trigger=0) never wake a turn on their own. A
 * runner command in the same batch must not change that: the context stays
 * pending and rides along with the next message that does wake a turn.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { MockProvider } from './providers/mock.js';
import { runPollLoop } from './poll-loop.js';
import type { AgentQuery, QueryInput } from './providers/types.js';

beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('slack-test', 'Slack Test', 'channel', 'slack', 'D123', NULL)`,
    )
    .run();
});
afterEach(() => closeSessionDb());

// Host-written rows carry even seq numbers in arrival order.
let seq = 0;
function insertMessage(id: string, text: string, threadId: string, trigger: 0 | 1) {
  seq += 2;
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, trigger, content)
       VALUES (?, ?, 'chat', datetime('now'), 'pending', 'D123', 'slack', ?, ?, ?)`,
    )
    .run(id, seq, threadId, trigger, JSON.stringify({ sender: 'Admin', text }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 5000) {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error('waitFor timeout');
    await sleep(25);
  }
}

/** Delivered chat rows as [text, thread]. */
function replies(): Array<[string, string | null]> {
  return getUndeliveredMessages()
    .filter((m) => m.kind === 'chat')
    .map((m) => [(JSON.parse(m.content) as { text: string }).text, m.thread_id]);
}

const labels = (prompt: string) => [...prompt.matchAll(/ask:(\w+)/g)].map((m) => m[1]);

class RecordingProvider extends MockProvider {
  prompts: string[] = [];
  constructor() {
    super({}, (prompt) => `<message to="slack-test">re: ${labels(prompt).join(' + ')}</message>`);
  }
  query(input: QueryInput): AgentQuery {
    this.prompts.push(input.prompt);
    return super.query(input);
  }
}

describe('a command batched with accumulated context only', () => {
  for (const command of ['/clear', '/upload-trace']) {
    it(`${command}: starts no turn for the context, which rides along with the next message`, async () => {
      const provider = new RecordingProvider();
      insertMessage('ctx', 'ambient ask:ctx', 'thread-ctx', 0);
      insertMessage('cmd', command, 'thread-cmd', 1);
      const controller = new AbortController();
      const loop = runPollLoop({
        provider,
        providerContract: { textDelivery: 'mid-turn-complete', commands: { formatting: 'xml' } },
        providerName: 'mock',
        cwd: '/tmp',
        signal: controller.signal,
      });
      try {
        await waitFor(() => replies().length > 0);
        await sleep(1200);
        // The command replies in its own thread and no turn answers the context.
        expect(replies().map(([, thread]) => thread)).toEqual(['thread-cmd']);
        expect(provider.prompts).toHaveLength(0);
        const ack = getOutboundDb().prepare(`SELECT status FROM processing_ack WHERE message_id = 'ctx'`).get();
        expect(ack).toBeNull();

        insertMessage('q', 'ask:q', 'thread-q', 1);
        await waitFor(() => provider.prompts.length === 1);
      } finally {
        controller.abort();
        await loop.catch(() => {});
      }
      expect(labels(provider.prompts[0])).toEqual(['ctx', 'q']);
    });
  }
});
