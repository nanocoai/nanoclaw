/**
 * Tools-only reply reconciliation across a follow-up push, in the shape a
 * shared wiring with threads creates: a `tools-only` group on one chat where
 * users post in threads. Two facts of that shape drive these tests:
 *
 *  - the session is not thread-bound (`session_routing.thread_id` is NULL),
 *    while the active reply route still carries the exact inbound thread;
 *  - the provider keeps one query open for the container's lifetime, so every
 *    later user message is a follow-up push, never a new outer batch.
 *
 * The tool sends below go through the real `send_message` handler so the rows
 * carry exactly the `in_reply_to` / `thread_id` production stamps on them —
 * and are held to the production per-turn send budget.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import * as realConfig from './config.js';
import { getUndeliveredMessages, writeMessageOut } from './db/messages-out.js';
import {
  clearCurrentReplyRoute,
  clearTurnOutboundBaseline,
  getCurrentInReplyTo,
  setCurrentReplyRoute,
  setTurnOutboundBaseline,
} from './db/session-state.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { sendMessage } from './mcp-tools/core.js';
import {
  processQuery,
  settleDeliveries,
  TOOLS_ONLY_ERROR_NOTICE,
  TOOLS_ONLY_PLACEHOLDER,
  type KnownRequest,
  type OutstandingReply,
} from './poll-loop.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';
import type { ReplyTarget, RoutingContext } from './formatter.js';
import type { Delivery } from './db/messages-out.js';

// The MCP send budget reads the group's mode off the config; the real loader
// caches a fixed mount path, so the mode is mocked for this file the way
// mcp-tools/core.test.ts does it.
const realLoadConfig = realConfig.loadConfig;
mock.module(`${import.meta.dir}/config.js`, () => ({
  ...realConfig,
  loadConfig: () => ({ ...realLoadConfig(), deliveryMode: 'tools-only' as const }),
}));

const CHANNEL = { platformId: 'channel-1', channelType: 'mattermost' };

/** Publish the full active route the current poll loop shares with MCP tools. */
function setCurrentInReplyTo(id: string): void {
  const suffix = id.startsWith('request-') ? id.slice('request-'.length) : null;
  setCurrentReplyRoute({ ...CHANNEL, threadId: suffix ? `thread-${suffix}` : null, inReplyTo: id });
}

function routingFor(id: string, threadId: string | null): RoutingContext {
  return {
    ...CHANNEL,
    threadId,
    inReplyTo: id,
    taskRun: false,
    replyTargets: [{ ...CHANNEL, threadId, inReplyTo: id }],
  };
}

/** A shared (non-thread-bound) session on one channel destination, plus a peer agent. */
function seedSharedSession(): void {
  const db = getInboundDb();
  db.exec(
    `CREATE TABLE session_routing (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       channel_type TEXT,
       platform_id TEXT,
       thread_id TEXT
     )`,
  );
  db.prepare('INSERT INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, ?, ?, NULL)').run(
    CHANNEL.channelType,
    CHANNEL.platformId,
  );
  db.prepare(
    `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
     VALUES ('mattermost-test', 'Mattermost', 'channel', ?, ?, NULL)`,
  ).run(CHANNEL.channelType, CHANNEL.platformId);
  db.prepare(
    `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
     VALUES ('peer', 'Peer agent', 'agent', NULL, NULL, 'peer-group')`,
  ).run();
}

function insertInbound(id: string, threadId: string, text: string, opts: { trigger?: 0 | 1; seq?: number } = {}): void {
  // `seq` is the host's even-numbered write order; the batch selector sorts
  // on it, so tests that care about in-batch order must set it.
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in
       (id, seq, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
       VALUES (?, ?, 'chat', ?, 'pending', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      opts.seq ?? null,
      new Date().toISOString(),
      opts.trigger ?? 1,
      CHANNEL.platformId,
      CHANNEL.channelType,
      threadId,
      JSON.stringify({ text }),
    );
}

async function waitForPush(pushes: string[], marker: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!pushes.some((text) => text.includes(marker)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function queryOver(events: AsyncGenerator<ProviderEvent>, pushes: string[]): AgentQuery {
  return { events, push: (text) => pushes.push(text), end: () => {}, abort: () => {} };
}

function visibleRows() {
  return getUndeliveredMessages().filter((row) => row.kind === 'chat' || row.kind === 'chat-sdk');
}

function visibleTexts(): string[] {
  return visibleRows().map((row) => JSON.parse(row.content).text);
}

function nudges(pushes: string[]): string[] {
  return pushes.filter((text) => text.includes('Nothing from your last turn'));
}

/** Run a tools-only query whose opening batch is one threaded request. */
function runToolsOnly(
  events: AsyncGenerator<ProviderEvent>,
  pushes: string[],
  routing: RoutingContext = routingFor('request-1', 'thread-1'),
  ids: string[] = ['request-1'],
): Promise<unknown> {
  return processQuery(
    queryOver(events, pushes),
    routing,
    ids,
    'mock',
    undefined,
    'prompt',
    undefined,
    false,
    'tools-only',
  );
}

/** Two threaded requests in one opening batch. */
const TWO_THREADS: RoutingContext = {
  ...routingFor('request-1', 'thread-1'),
  replyTargets: [
    { ...CHANNEL, threadId: 'thread-1', inReplyTo: 'request-1' },
    { ...CHANNEL, threadId: 'thread-2', inReplyTo: 'request-2' },
  ],
};

beforeEach(() => {
  initTestSessionDb();
  seedSharedSession();
});
afterEach(() => {
  clearCurrentReplyRoute();
  clearTurnOutboundBaseline();
  closeSessionDb();
});

describe('tools-only reconciliation across a follow-up push', () => {
  it('attributes a tool send made after a follow-up push to the follow-up — no duplicate coax, no placeholder', async () => {
    const pushes: string[] = [];
    const stampAtSecondSend: Array<string | null> = [];
    // What runPollLoop publishes at batch start.
    setCurrentInReplyTo('request-1');

    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'continuation-1' };
      await sendMessage.handler({ to: 'mattermost-test', text: 'ALPHA' });
      yield { type: 'result', text: 'sent alpha' };

      // The user replies in a different thread while the query stays open.
      insertInbound('request-2', 'thread-2', 'second question');
      await waitForPush(pushes, 'second question');
      stampAtSecondSend.push(getCurrentInReplyTo());
      await sendMessage.handler({ to: 'mattermost-test', text: 'BETA' });
      yield { type: 'result', text: 'sent beta' };

      // A trailing dry turn: this is where an unmatched request-2 would be
      // paid off with the fixed placeholder.
      yield { type: 'result', text: 'nothing further' };
    }

    await runToolsOnly(events(), pushes);

    expect(stampAtSecondSend).toEqual(['request-2']);
    expect(nudges(pushes)).toEqual([]);
    expect(visibleTexts()).toEqual(['ALPHA', 'BETA']);
    expect(visibleRows()[1].in_reply_to).toBe('request-2');
    expect(visibleRows()[1].thread_id).toBe('thread-2');
  });

  it('judges a follow-up only at its own result: an earlier turn ending must not nudge a request whose prompt is still queued', async () => {
    // Live-observed (2026-09-02, tools-only group, shared session with
    // threads): "say ALPHA" then "say BETA" 3 s later while ALPHA's turn was
    // live. BETA was pushed as a follow-up; ALPHA's result then found BETA
    // outstanding, judged it undelivered and queued the correction. The
    // provider ran BETA's prompt (one BETA sent), then the correction — and
    // the model sent BETA again.
    const pushes: string[] = [];
    setCurrentInReplyTo('request-1');

    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'continuation-1' };
      await sendMessage.handler({ to: 'mattermost-test', text: 'ALPHA' });
      // BETA lands while ALPHA's turn is still live and is pushed behind it.
      insertInbound('request-2', 'thread-2', 'second: say BETA');
      await waitForPush(pushes, 'second: say BETA');
      // ALPHA's turn ends. request-2's prompt has not run yet.
      yield { type: 'result', text: 'sent alpha' };

      // The provider now runs the queued BETA prompt.
      await sendMessage.handler({ to: 'mattermost-test', text: 'BETA' });
      yield { type: 'result', text: 'sent beta' };

      // If a correction was queued behind BETA, the model obeys it — that is
      // the duplicate the user saw.
      if (nudges(pushes).length > 0) {
        await sendMessage.handler({ to: 'mattermost-test', text: 'BETA' });
        yield { type: 'result', text: 'sent beta again' };
      }
    }

    await runToolsOnly(events(), pushes);

    expect(nudges(pushes)).toEqual([]);
    expect(visibleTexts()).toEqual(['ALPHA', 'BETA']);
    expect(visibleRows().map((row) => row.in_reply_to)).toEqual(['request-1', 'request-2']);
  });

  it('still corrects, then places the placeholder, for a queued follow-up once its own turn stays dry', async () => {
    // Same shape as above, but BETA's own turn sends nothing: the correction
    // must fire at BETA's result (not ALPHA's), and the placeholder only at
    // the correction's own result.
    const pushes: string[] = [];
    const nudgeCountAtBetaTurn: number[] = [];
    setCurrentInReplyTo('request-1');

    async function* events(): AsyncGenerator<ProviderEvent> {
      await sendMessage.handler({ to: 'mattermost-test', text: 'ALPHA' });
      insertInbound('request-2', 'thread-2', 'second: say BETA');
      await waitForPush(pushes, 'second: say BETA');
      yield { type: 'result', text: 'sent alpha' };
      nudgeCountAtBetaTurn.push(nudges(pushes).length);
      // BETA's prompt runs dry.
      yield { type: 'result', text: 'thought about beta' };
      // The correction's prompt runs dry too.
      yield { type: 'result', text: 'still nothing' };
    }

    await runToolsOnly(events(), pushes);

    expect(nudgeCountAtBetaTurn).toEqual([0]);
    expect(nudges(pushes)).toHaveLength(1);
    const rows = visibleRows();
    expect(rows.map((row) => JSON.parse(row.content).text)).toEqual(['ALPHA', TOOLS_ONLY_PLACEHOLDER]);
    expect(rows[1].in_reply_to).toBe('request-2');
    expect(rows[1].thread_id).toBe('thread-2');
  });

  it('keeps the live turn stamped for its own request when a follow-up is pushed before the live turn sends', async () => {
    // BETA is pushed while ALPHA's turn is live and ALPHA's send_message lands
    // AFTER the push. That send answers ALPHA; it must carry request-1, not
    // the queued request-2, or the exact-stamp match pays off BETA with it,
    // ALPHA is judged dry, and the user sees ALPHA, BETA, ALPHA-again and a
    // placeholder.
    const pushes: string[] = [];
    const stamps: Array<string | null> = [];
    setCurrentInReplyTo('request-1');

    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'continuation-1' };
      insertInbound('request-2', 'thread-2', 'second: say BETA');
      await waitForPush(pushes, 'second: say BETA');
      stamps.push(getCurrentInReplyTo());
      await sendMessage.handler({ to: 'mattermost-test', text: 'ALPHA' });
      yield { type: 'result', text: 'sent alpha' };

      // BETA's queued prompt runs.
      stamps.push(getCurrentInReplyTo());
      await sendMessage.handler({ to: 'mattermost-test', text: 'BETA' });
      yield { type: 'result', text: 'sent beta' };

      if (nudges(pushes).length > 0) {
        await sendMessage.handler({ to: 'mattermost-test', text: 'ALPHA' });
        yield { type: 'result', text: 'sent alpha again' };
      }
    }

    await runToolsOnly(events(), pushes);

    expect(stamps).toEqual(['request-1', 'request-2']);
    expect(nudges(pushes)).toEqual([]);
    expect(visibleTexts()).toEqual(['ALPHA', 'BETA']);
    expect(visibleRows().map((row) => row.in_reply_to)).toEqual(['request-1', 'request-2']);
  });

  it('stamps the correction turn for the request it retries, after a queued follow-up ran in between', async () => {
    // ALPHA's turn is dry, BETA is queued behind it and is answered on its own
    // turn, then the model correctly sends ALPHA at the correction. That send
    // must carry request-1 so ALPHA's asker is paid off instead of getting the
    // placeholder on top of the real reply.
    const pushes: string[] = [];
    const stamps: Array<string | null> = [];
    setCurrentInReplyTo('request-1');

    async function* events(): AsyncGenerator<ProviderEvent> {
      insertInbound('request-2', 'thread-2', 'second: say BETA');
      await waitForPush(pushes, 'second: say BETA');
      yield { type: 'result', text: 'thought about alpha' };

      // BETA's queued prompt runs.
      stamps.push(getCurrentInReplyTo());
      await sendMessage.handler({ to: 'mattermost-test', text: 'BETA' });
      yield { type: 'result', text: 'sent beta' };

      // The correction for ALPHA runs and the model obeys it.
      stamps.push(getCurrentInReplyTo());
      await sendMessage.handler({ to: 'mattermost-test', text: 'ALPHA' });
      yield { type: 'result', text: 'sent alpha' };
    }

    await runToolsOnly(events(), pushes);

    expect(nudges(pushes)).toHaveLength(1);
    expect(stamps).toEqual(['request-2', 'request-1']);
    expect(visibleTexts()).toEqual(['BETA', 'ALPHA']);
    expect(visibleRows().map((row) => row.in_reply_to)).toEqual(['request-2', 'request-1']);
  });

  it('opens a fresh send budget for the correction when the turn already sent to that address for someone else', async () => {
    // Two threaded askers in one batch on a shared session: one thread-less
    // send answers the older one. The correction for the other must be able
    // to send to the same channel again — under the live turn's budget that
    // second send would be refused and the asker would only ever get the
    // placeholder over a reply the model was willing to give.
    const pushes: string[] = [];
    // What runPollLoop publishes at batch start: the stamp and the budget baseline.
    setCurrentInReplyTo('request-2');
    setTurnOutboundBaseline(0);

    async function* events(): AsyncGenerator<ProviderEvent> {
      await sendMessage.handler({ to: 'mattermost-test', text: 'One answer.' });
      yield { type: 'result', text: 'sent one' };
      // The correction's turn: the model sends for the other asker.
      await sendMessage.handler({ to: 'mattermost-test', text: 'And the other answer.' });
      yield { type: 'result', text: 'sent two' };
      yield { type: 'result', text: 'nothing further' };
    }

    await runToolsOnly(events(), pushes, TWO_THREADS, ['request-1', 'request-2']);

    expect(nudges(pushes)).toHaveLength(1);
    expect(visibleTexts()).toEqual(['One answer.', 'And the other answer.']);
    expect(visibleRows().map((row) => row.in_reply_to)).toEqual(['request-2', 'request-1']);
  });

  it('notices only the erroring exchange, not a follow-up whose prompt still runs afterwards', async () => {
    // An isError result ends ALPHA's turn while BETA is queued behind it.
    // BETA's prompt still runs and answers itself; it must not also get the
    // error notice.
    const pushes: string[] = [];
    setCurrentInReplyTo('request-1');

    async function* events(): AsyncGenerator<ProviderEvent> {
      insertInbound('request-2', 'thread-2', 'second: say BETA');
      await waitForPush(pushes, 'second: say BETA');
      yield { type: 'result', text: 'upstream failure detail', isError: true };

      await sendMessage.handler({ to: 'mattermost-test', text: 'BETA' });
      yield { type: 'result', text: 'sent beta' };
    }

    await runToolsOnly(events(), pushes);

    expect(nudges(pushes)).toEqual([]);
    expect(visibleTexts()).toEqual([TOOLS_ONLY_ERROR_NOTICE, 'BETA']);
    expect(visibleRows().map((row) => row.in_reply_to)).toEqual(['request-1', 'request-2']);
  });

  it('stamps the engaging mention, not an accumulated context row, when a follow-up batch mixes both', async () => {
    // Live-observed: a reply stamped with the first accumulated trigger=0
    // row's id while the engaging mention was a later row.
    const pushes: string[] = [];
    const stampAtSend: Array<string | null> = [];
    setCurrentInReplyTo('request-1');

    async function* events(): AsyncGenerator<ProviderEvent> {
      await sendMessage.handler({ to: 'mattermost-test', text: 'ALPHA' });
      yield { type: 'result', text: 'sent alpha' };
      insertInbound('context-1', 'thread-2', 'ambient chatter', { trigger: 0, seq: 2 });
      insertInbound('context-2', 'thread-2', 'more chatter', { trigger: 0, seq: 4 });
      insertInbound('request-2', 'thread-2', '@agent second question', { seq: 6 });
      await waitForPush(pushes, 'second question');
      stampAtSend.push(getCurrentInReplyTo());
      await sendMessage.handler({ to: 'mattermost-test', text: 'BETA' });
      yield { type: 'result', text: 'sent beta' };
    }

    await runToolsOnly(events(), pushes);

    expect(stampAtSend).toEqual(['request-2']);
    expect(nudges(pushes)).toEqual([]);
    expect(visibleRows().map((row) => row.in_reply_to)).toEqual(['request-1', 'request-2']);
  });

  it('re-points the tool stamp at each follow-up in envelope mode too', async () => {
    const pushes: string[] = [];
    const stamps: Array<string | null> = [];
    setCurrentInReplyTo('request-1');

    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'result', text: '<message to="mattermost-test">one</message>' };
      insertInbound('request-2', 'thread-2', 'second question');
      await waitForPush(pushes, 'second question');
      stamps.push(getCurrentInReplyTo());
      yield { type: 'result', text: '<message to="mattermost-test">two</message>' };
    }

    await processQuery(queryOver(events(), pushes), routingFor('request-1', 'thread-1'), ['request-1'], 'mock');

    expect(stamps).toEqual(['request-2']);
    expect(visibleTexts()).toEqual(['one', 'two']);
  });
  it('judges a same-address follow-up at its own turn, not by the reply the turn before it gave', async () => {
    // DM shape: every request shares one address (thread null). ALPHA answers
    // request-1 while request-2 is queued behind it. request-2's own turn goes
    // dry: it must be corrected and then placed, not counted as answered by
    // ALPHA, which was sent before its prompt ran.
    const pushes: string[] = [];
    setCurrentInReplyTo('request-1');

    async function* events(): AsyncGenerator<ProviderEvent> {
      await sendMessage.handler({ to: 'mattermost-test', text: 'ALPHA' });
      insertInbound('request-2', null, 'second: say BETA');
      await waitForPush(pushes, 'second: say BETA');
      yield { type: 'result', text: 'sent alpha' };
      yield { type: 'result', text: 'thought about beta' };
      yield { type: 'result', text: 'still nothing' };
    }

    await runToolsOnly(events(), pushes, routingFor('request-1', null));

    expect(nudges(pushes)).toHaveLength(1);
    const rows = visibleRows();
    expect(rows.map((row) => JSON.parse(row.content).text)).toEqual(['ALPHA', TOOLS_ONLY_PLACEHOLDER]);
    expect(rows.map((row) => row.in_reply_to)).toEqual(['request-1', 'request-2']);
  });

  it('judges two follow-ups pushed during one live turn each at their own result', async () => {
    const pushes: string[] = [];
    setCurrentInReplyTo('request-1');

    async function* events(): AsyncGenerator<ProviderEvent> {
      await sendMessage.handler({ to: 'mattermost-test', text: 'ALPHA' });
      insertInbound('request-2', 'thread-2', 'second: say BETA');
      await waitForPush(pushes, 'second: say BETA');
      insertInbound('request-3', 'thread-3', 'third: say GAMMA');
      await waitForPush(pushes, 'third: say GAMMA');
      yield { type: 'result', text: 'sent alpha' };
      // request-2's turn answers itself.
      await sendMessage.handler({ to: 'mattermost-test', text: 'BETA' });
      yield { type: 'result', text: 'sent beta' };
      // request-3's turn is dry: corrected here, placed at the correction's result.
      yield { type: 'result', text: 'thought about gamma' };
      yield { type: 'result', text: 'still nothing' };
    }

    await runToolsOnly(events(), pushes);

    expect(nudges(pushes)).toHaveLength(1);
    const rows = visibleRows();
    expect(rows.map((row) => JSON.parse(row.content).text)).toEqual(['ALPHA', 'BETA', TOOLS_ONLY_PLACEHOLDER]);
    expect(rows.map((row) => row.in_reply_to)).toEqual(['request-1', 'request-2', 'request-3']);
    expect(rows[2].thread_id).toBe('thread-3');
  });

  it('notices only the corrected request when the correction itself errors with a follow-up queued', async () => {
    const pushes: string[] = [];
    setCurrentInReplyTo('request-1');

    async function* events(): AsyncGenerator<ProviderEvent> {
      // request-1 dry → correction queued as exchange 1.
      yield { type: 'result', text: 'thought about alpha' };
      insertInbound('request-2', 'thread-2', 'second: say BETA');
      await waitForPush(pushes, 'second: say BETA');
      // The correction's turn fails.
      yield { type: 'result', text: 'upstream failure detail', isError: true };
      // request-2's queued prompt still runs and answers itself.
      await sendMessage.handler({ to: 'mattermost-test', text: 'BETA' });
      yield { type: 'result', text: 'sent beta' };
    }

    await runToolsOnly(events(), pushes);

    expect(nudges(pushes)).toHaveLength(1);
    expect(visibleTexts()).toEqual([TOOLS_ONLY_ERROR_NOTICE, 'BETA']);
    expect(visibleRows().map((row) => row.in_reply_to)).toEqual(['request-1', 'request-2']);
  });
});

describe('tools-only attribution of a tool send to a request', () => {
  it('accepts a thread-less tool send on the requesting chat as the reply to a threaded request', async () => {
    const pushes: string[] = [];
    async function* events(): AsyncGenerator<ProviderEvent> {
      // The shape of a `send_message` row in a shared session whose stamp is
      // stale: an older batch's id and the session's NULL thread.
      await writeMessageOut({
        id: 'tool-send-1',
        in_reply_to: 'request-0',
        kind: 'chat',
        platform_id: CHANNEL.platformId,
        channel_type: CHANNEL.channelType,
        thread_id: null,
        content: JSON.stringify({ text: 'Answered on the channel.' }),
      });
      yield { type: 'result', text: 'sent' };
    }

    await runToolsOnly(events(), pushes);

    expect(nudges(pushes)).toEqual([]);
    expect(visibleTexts()).toEqual(['Answered on the channel.']);
  });

  it('lets one thread-less send satisfy only the oldest of two threaded requests in one batch', async () => {
    const pushes: string[] = [];
    async function* events(): AsyncGenerator<ProviderEvent> {
      await writeMessageOut({
        id: 'tool-send-1',
        in_reply_to: 'request-0',
        kind: 'chat',
        platform_id: CHANNEL.platformId,
        channel_type: CHANNEL.channelType,
        thread_id: null,
        content: JSON.stringify({ text: 'One answer.' }),
      });
      yield { type: 'result', text: 'sent one' };
      yield { type: 'result', text: 'retry remained dry' };
    }

    await runToolsOnly(events(), pushes, TWO_THREADS, ['request-1', 'request-2']);

    expect(nudges(pushes)).toHaveLength(1);
    const rows = visibleRows();
    expect(rows.map((row) => JSON.parse(row.content).text)).toEqual(['One answer.', TOOLS_ONLY_PLACEHOLDER]);
    expect(rows[1].in_reply_to).toBe('request-2');
    expect(rows[1].thread_id).toBe('thread-2');
  });

  it('attributes by exact stamp first: a send stamped for the newer request leaves the older one open', async () => {
    const pushes: string[] = [];
    async function* events(): AsyncGenerator<ProviderEvent> {
      await writeMessageOut({
        id: 'tool-send-1',
        in_reply_to: 'request-2',
        kind: 'chat',
        platform_id: CHANNEL.platformId,
        channel_type: CHANNEL.channelType,
        thread_id: null,
        content: JSON.stringify({ text: 'Answer for two.' }),
      });
      yield { type: 'result', text: 'sent two' };
      yield { type: 'result', text: 'retry remained dry' };
    }

    await runToolsOnly(events(), pushes, TWO_THREADS, ['request-1', 'request-2']);

    expect(nudges(pushes)).toHaveLength(1);
    const rows = visibleRows();
    expect(rows).toHaveLength(2);
    expect(rows[1].in_reply_to).toBe('request-1');
    expect(rows[1].thread_id).toBe('thread-1');
  });

  it('keeps two rows stamped for one asker on that asker: send_message then send_file never pays off the other', async () => {
    const pushes: string[] = [];
    async function* events(): AsyncGenerator<ProviderEvent> {
      for (const [id, text] of [
        ['tool-send-1', 'Here is the summary.'],
        ['tool-file-1', 'And the file.'],
      ]) {
        await writeMessageOut({
          id,
          in_reply_to: 'request-1',
          kind: 'chat',
          platform_id: CHANNEL.platformId,
          channel_type: CHANNEL.channelType,
          thread_id: null,
          content: JSON.stringify({ text }),
        });
      }
      yield { type: 'result', text: 'sent both to one' };
      yield { type: 'result', text: 'retry remained dry' };
    }

    await runToolsOnly(events(), pushes, TWO_THREADS, ['request-1', 'request-2']);

    expect(nudges(pushes)).toHaveLength(1);
    const rows = visibleRows();
    expect(rows).toHaveLength(3);
    expect(rows[2].in_reply_to).toBe('request-2');
    expect(rows[2].thread_id).toBe('thread-2');
  });

  it('does not let a late row stamped for an already-answered request pay off a newer follow-up', async () => {
    const pushes: string[] = [];
    async function* events(): AsyncGenerator<ProviderEvent> {
      await writeMessageOut({
        id: 'tool-send-1',
        in_reply_to: 'request-1',
        kind: 'chat',
        platform_id: CHANNEL.platformId,
        channel_type: CHANNEL.channelType,
        thread_id: null,
        content: JSON.stringify({ text: 'Answer one.' }),
      });
      yield { type: 'result', text: 'sent one' };
      // request-1 is now settled. A follow-up arrives, and the next row still
      // carries request-1's stamp (read by the tool subprocess before the
      // refresh) — it belongs to request-1's thread of work, not to request-2.
      insertInbound('request-2', 'thread-2', 'second question');
      await waitForPush(pushes, 'second question');
      await writeMessageOut({
        id: 'tool-file-1',
        in_reply_to: 'request-1',
        kind: 'chat',
        platform_id: CHANNEL.platformId,
        channel_type: CHANNEL.channelType,
        thread_id: null,
        content: JSON.stringify({ text: 'Attachment for one.' }),
      });
      yield { type: 'result', text: 'sent file' };
      yield { type: 'result', text: 'retry remained dry' };
    }

    await runToolsOnly(events(), pushes);

    expect(nudges(pushes)).toHaveLength(1);
    const rows = visibleRows();
    expect(rows).toHaveLength(3);
    expect(rows[2].in_reply_to).toBe('request-2');
    expect(rows[2].thread_id).toBe('thread-2');
  });

  it('still holds a request open when the only sends are pinned to another thread or another chat', async () => {
    const pushes: string[] = [];
    async function* events(): AsyncGenerator<ProviderEvent> {
      await writeMessageOut({
        id: 'other-thread',
        in_reply_to: 'request-0',
        kind: 'chat',
        platform_id: CHANNEL.platformId,
        channel_type: CHANNEL.channelType,
        thread_id: 'thread-9',
        content: JSON.stringify({ text: 'Different thread.' }),
      });
      await writeMessageOut({
        id: 'other-chat',
        in_reply_to: 'request-0',
        kind: 'chat',
        platform_id: 'channel-2',
        channel_type: 'slack',
        thread_id: null,
        content: JSON.stringify({ text: 'Different chat.' }),
      });
      yield { type: 'result', text: 'sent elsewhere' };
    }

    await runToolsOnly(events(), pushes);

    expect(nudges(pushes)).toHaveLength(1);
  });

  it('does not let a peer-agent send stamped with the asker’s id discharge the asker', async () => {
    // The tools stamp every row of the turn, a send to a peer agent included.
    // The stamp names the request the model was working on, not the person it
    // reached: an agent-channel row is not a reply this person received.
    const pushes: string[] = [];
    setCurrentInReplyTo('request-1');

    async function* events(): AsyncGenerator<ProviderEvent> {
      await sendMessage.handler({ to: 'peer', text: 'hey peer, any idea?' });
      yield { type: 'result', text: 'asked the other agent' };
      yield { type: 'result', text: 'still waiting on them' };
    }

    await runToolsOnly(events(), pushes);

    expect(nudges(pushes)).toHaveLength(1);
    const peerRow = visibleRows().find((row) => row.channel_type === 'agent');
    expect(peerRow?.in_reply_to).toBe('request-1');
    const toHuman = visibleRows().filter((row) => row.channel_type === CHANNEL.channelType);
    expect(toHuman.map((row) => JSON.parse(row.content).text)).toEqual([TOOLS_ONLY_PLACEHOLDER]);
  });

  it('closes every same-address question with one reply there, and settles by address when the stamp is for another chat', async () => {
    // Discord and Slack ask in one batch; the batch stamp is the last row's
    // (Slack). The model answers Discord first: that row's stamp names a
    // request on another chat, so it is matched by address — and one row at
    // an address answers everyone waiting exactly there.
    const pushes: string[] = [];
    const routing: RoutingContext = {
      ...routingFor('request-1', null),
      replyTargets: [
        { ...CHANNEL, threadId: null, inReplyTo: 'request-1' },
        { ...CHANNEL, threadId: null, inReplyTo: 'request-1b' },
        { platformId: 'channel-2', channelType: 'slack', threadId: null, inReplyTo: 'request-2' },
      ],
    };
    async function* events(): AsyncGenerator<ProviderEvent> {
      await writeMessageOut({
        id: 'to-discord',
        in_reply_to: 'request-2',
        kind: 'chat',
        platform_id: CHANNEL.platformId,
        channel_type: CHANNEL.channelType,
        thread_id: null,
        content: JSON.stringify({ text: 'For the first chat.' }),
      });
      yield { type: 'result', text: 'sent one' };
      yield { type: 'result', text: 'retry remained dry' };
    }

    await runToolsOnly(events(), pushes, routing, ['request-1', 'request-1b', 'request-2']);

    expect(nudges(pushes)).toHaveLength(1);
    const rows = visibleRows();
    expect(rows.map((row) => row.in_reply_to)).toEqual(['request-2', 'request-2']);
    expect(rows[1].platform_id).toBe('channel-2');
    expect(JSON.parse(rows[1].content).text).toBe(TOOLS_ONLY_PLACEHOLDER);
  });
});

describe('settleDeliveries', () => {
  const at = (threadId: string | null, inReplyTo: string): ReplyTarget => ({ ...CHANNEL, threadId, inReplyTo });
  const entry = (target: ReplyTarget | undefined, exchange: number): OutstandingReply => ({
    target,
    nudged: false,
    exchange,
  });
  const row = (seq: number, inReplyTo: string | null, threadId: string | null, chat = CHANNEL): Delivery => ({
    seq,
    inReplyTo,
    threadId,
    platformId: chat.platformId,
    channelType: chat.channelType,
  });
  const ids = (outstanding: OutstandingReply[]): Array<string | null> =>
    outstanding.map((o) => o.target?.inReplyTo ?? null);

  it('settles a stamped request whatever its exchange, and same-address requests only from the same prompt', () => {
    const q1 = entry(at(null, 'q1'), 0);
    const q1b = entry(at(null, 'q1b'), 0);
    const q2 = entry(at(null, 'q2'), 1);
    const outstanding = [q1, q1b, q2];
    settleDeliveries(outstanding, new Map(), [row(1, 'q1', null)], 0);
    expect(ids(outstanding)).toEqual(['q2']);
  });

  it('settles a queued request by its stamp before its prompt has run', () => {
    const q1 = entry(at('thread-1', 'q1'), 0);
    const q2 = entry(at('thread-2', 'q2'), 1);
    const outstanding = [q1, q2];
    settleDeliveries(outstanding, new Map(), [row(1, 'q2', null)], 0);
    expect(ids(outstanding)).toEqual(['q1']);
  });

  it('does not let an address match reach a request whose prompt has not run', () => {
    const q1 = entry(at(null, 'q1'), 0);
    const q2 = entry(at(null, 'q2'), 1);
    const outstanding = [q1, q2];
    settleDeliveries(outstanding, new Map(), [row(1, 'stale', null)], 0);
    expect(ids(outstanding)).toEqual(['q2']);
    settleDeliveries(outstanding, new Map(), [row(2, 'stale', null)], 1);
    expect(ids(outstanding)).toEqual([]);
  });

  it('keeps a late row for a settled request on that request, and on its batch-mates only', () => {
    const known = new Map<string, KnownRequest>([['q1', { target: at(null, 'q1'), exchange: 0 }]]);
    const q1b = entry(at(null, 'q1b'), 0);
    const q2 = entry(at(null, 'q2'), 1);
    const outstanding = [q1b, q2];
    settleDeliveries(outstanding, known, [row(5, 'q1', null)], 1);
    expect(ids(outstanding)).toEqual(['q2']);
  });

  it('lets a thread-less row answer the oldest threaded request only', () => {
    const q1 = entry(at('thread-1', 'q1'), 0);
    const q2 = entry(at('thread-2', 'q2'), 0);
    const outstanding = [q1, q2];
    settleDeliveries(outstanding, new Map(), [row(1, null, null)], 0);
    expect(ids(outstanding)).toEqual(['q2']);
  });

  it('ignores a peer-agent row stamped with the asker’s id, and any row on another chat', () => {
    const q1 = entry(at(null, 'q1'), 0);
    const outstanding = [q1];
    settleDeliveries(
      outstanding,
      new Map(),
      [
        row(1, 'q1', null, { platformId: 'peer-group', channelType: 'agent' }),
        row(2, null, null, { platformId: 'c2', channelType: 'slack' }),
      ],
      0,
    );
    expect(ids(outstanding)).toEqual(['q1']);
  });

  it('settles a targetless wake by any row, once its prompt has run', () => {
    const wake = entry(undefined, 1);
    const outstanding = [wake];
    settleDeliveries(outstanding, new Map(), [row(1, null, null)], 0);
    expect(outstanding).toHaveLength(1);
    settleDeliveries(outstanding, new Map(), [row(2, null, null)], 1);
    expect(outstanding).toHaveLength(0);
  });
});
