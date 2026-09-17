/**
 * Tests for the core MCP tools' routing context: the a2a reply stamp and the
 * thread an outbound row is addressed to.
 *
 * The in_reply_to stamp is published through session_state in outbound.db, not
 * module state — the MCP server runs as a separate stdio subprocess from the
 * poll loop, so it can only see the stamp through the shared DB. These tests
 * seed it the same way the poll-loop process does (a direct DB write) rather
 * than via any in-memory helper, so they exercise the real process boundary.
 */
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import fs from 'fs';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../mailbox/sqlite/connection.js';
import * as realConfig from '../config.js';
import type { DeliveryMode } from '../config.js';
import { getMaxOutboundSeq, getUndeliveredMessages, writeMessageOut } from '../db/messages-out.js';
import { sendFile, sendMessage } from './core.js';

/**
 * The group's delivery mode, swapped per test.
 *
 * The real loadConfig() reads a fixed mount path and caches the first file it
 * saw, so a test cannot point it at a temp container.json without poisoning the
 * cache for the process. Mocking the module is per-file in bun, so the config
 * tests elsewhere still exercise the real loader.
 */
let deliveryMode: DeliveryMode = 'envelope';
/** Captured before the mock lands, so the override never calls itself. */
const realLoadConfig = realConfig.loadConfig;
mock.module(`${import.meta.dir}/../config.js`, () => ({
  ...realConfig,
  loadConfig: () => ({ ...realLoadConfig(), deliveryMode }),
}));

/** The text an MCP tool handed back. */
function resultText(result: { content: unknown[] }): string {
  return (result.content[0] as { text: string }).text;
}

/**
 * Publish the reply route the way the poll loop does: a direct write to
 * session_state in outbound.db. `ageMs` back-dates updated_at to prove a real
 * long-running turn remains valid regardless of timestamp age.
 */
function publishReplyRoute(
  route: { inReplyTo: string; channelType?: string | null; platformId?: string | null; threadId?: string | null },
  ageMs = 0,
): void {
  const updatedAt = new Date(Date.now() - ageMs).toISOString();
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run(
      'current_reply_route',
      JSON.stringify({
        inReplyTo: route.inReplyTo,
        channelType: route.channelType ?? null,
        platformId: route.platformId ?? null,
        threadId: route.threadId ?? null,
      }),
      updatedAt,
    );
}

function publishInReplyTo(id: string, ageMs = 0): void {
  publishReplyRoute({ inReplyTo: id }, ageMs);
}

/** The session's bound chat/thread, as the host writes it on every wake. */
function seedBoundThread(channelType: string, platformId: string, threadId: string | null): void {
  const db = getInboundDb();
  db.exec(`CREATE TABLE IF NOT EXISTS session_routing (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    channel_type TEXT, platform_id TEXT, thread_id TEXT
  )`);
  db.prepare('INSERT INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, ?, ?, ?)').run(
    channelType,
    platformId,
    threadId,
  );
}

function seedChannelDestination(name: string, channelType: string, platformId: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', ?, ?, NULL)`,
    )
    .run(name, name, channelType, platformId);
}

let hostSeq = 0;

/**
 * An inbound row as the host routes it. `seq` steps by two because the host
 * owns even sequence numbers and the container odd ones — that parity is what
 * `getMessageIdBySeq` routes on, so an odd inbound row could never exist.
 */
function seedInbound(id: string, channelType: string, platformId: string, threadId: string | null): void {
  hostSeq += 2;
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, ?, 'chat', ?, 'completed', ?, ?, ?, ?)`,
    )
    .run(
      id,
      hostSeq,
      new Date().toISOString(),
      platformId,
      channelType,
      threadId,
      JSON.stringify({ sender: 'Alice', text: 'hi' }),
    );
}

/**
 * Publish the turn's outbound baseline the way the poll loop does — the same
 * direct DB write, since the MCP server cannot see the loop's module state.
 * The loop republishes this per turn, including when a follow-up batch is
 * pushed into a query that is already open.
 */
function publishTurnBaseline(seq: number): void {
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('turn_outbound_baseline', String(seq), new Date().toISOString());
}

beforeEach(() => {
  deliveryMode = 'envelope';
  initTestSessionDb();
  hostSeq = 0;
  // Seed two peer agent destinations — the second one is what proves a repeat
  // aimed somewhere else is a different message, not a duplicate.
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('peer', 'Peer', 'agent', NULL, NULL, 'ag-peer'),
              ('other-peer', 'Other Peer', 'agent', NULL, NULL, 'ag-other-peer')`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

describe('send_message MCP tool — in_reply_to plumbing', () => {
  it('stamps the batch in_reply_to (published via the DB) on outbound rows', async () => {
    publishInReplyTo('inbound-msg-1');

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('inbound-msg-1');
  });

  it('writes null when no batch is active', async () => {
    // Nothing published to session_state — simulates ad-hoc / out-of-batch invocation.
    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });

  it('honors a stamp of any age — a turn may run longer than any fixed limit (dead stamps are cleared at startup, see turn-routing.test.ts)', async () => {
    publishInReplyTo('inbound-msg-1', 3 * 60 * 60 * 1000); // three hours into the turn

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('inbound-msg-1');
  });
});

describe('send_message / send_file — thread for a channel destination', () => {
  // send_file stages the file under /workspace/outbox, which only exists in a
  // container. Routing is what's under test, so stub the copy.
  let fsSpies: Array<{ mockRestore(): void }> = [];

  beforeEach(() => {
    seedChannelDestination('current-chat', 'slack', 'C123');
    fsSpies = [
      spyOn(fs, 'existsSync').mockReturnValue(true),
      spyOn(fs, 'mkdirSync').mockReturnValue(undefined),
      spyOn(fs, 'copyFileSync').mockReturnValue(undefined),
    ];
  });

  afterEach(() => {
    for (const spy of fsSpies) spy.mockRestore();
  });

  async function sendBoth(): Promise<Array<string | null>> {
    await sendMessage.handler({ to: 'current-chat', text: 'hello' });
    const file = (await sendFile.handler({ to: 'current-chat', path: '/tmp/report.txt' })) as { isError?: boolean };
    expect(file.isError).toBeUndefined();
    return getUndeliveredMessages().map((m) => m.thread_id);
  }

  it('replies in the thread of the message being answered, even when the session has no bound thread', async () => {
    // A shared / agent-shared session (or a DM sub-thread) is bound to the
    // channel with no thread of its own, but the request came in a thread.
    // The old code read the bound thread and sent the file to the top level.
    seedBoundThread('slack', 'C123', null);
    seedInbound('in-1', 'slack', 'C123', 'T-42');
    publishReplyRoute({ inReplyTo: 'in-1', channelType: 'slack', platformId: 'C123', threadId: 'T-42' });

    expect(await sendBoth()).toEqual(['T-42', 'T-42']);
  });

  it('keeps replying to the answered message when a newer message from another thread arrived mid-turn', async () => {
    seedInbound('in-1', 'slack', 'C123', 'T-1');
    seedInbound('in-2', 'slack', 'C123', 'T-42');
    publishReplyRoute({ inReplyTo: 'in-1', channelType: 'slack', platformId: 'C123', threadId: 'T-1' });

    expect(await sendBoth()).toEqual(['T-1', 'T-1']);
  });

  it("ignores the session's bound thread and falls back to the latest inbound thread out of a batch", async () => {
    seedBoundThread('slack', 'C123', 'T-bound');
    seedInbound('in-1', 'slack', 'C123', 'T-1');
    seedInbound('in-2', 'slack', 'C123', 'T-42');

    expect(await sendBoth()).toEqual(['T-42', 'T-42']);
  });

  it("uses the destination channel's own latest thread when answering a message from another channel", async () => {
    // agent-shared session: answering discord, sending to slack.
    seedInbound('in-0', 'slack', 'C123', 'T-9');
    seedInbound('in-1', 'discord', 'chan-9', 'discord-thread');
    publishReplyRoute({ inReplyTo: 'in-1', channelType: 'discord', platformId: 'chan-9', threadId: 'discord-thread' });

    expect(await sendBoth()).toEqual(['T-9', 'T-9']);
  });

  it('sends unthreaded to a channel nothing has arrived from', async () => {
    seedInbound('in-1', 'discord', 'chan-9', 'discord-thread');
    publishReplyRoute({ inReplyTo: 'in-1', channelType: 'discord', platformId: 'chan-9', threadId: 'discord-thread' });

    expect(await sendBoth()).toEqual([null, null]);
  });
});

/**
 * A tools-only group delivers nothing except what an outbound tool call writes.
 * Small models can continue after a successful send and retry with paraphrases,
 * so exact-text dedupe is not a sufficient boundary. One plain send_message per
 * destination per turn is allowed; later attempts are acknowledged without a
 * write and told to stop rather than retry or rephrase.
 *
 * The turn boundary is the outbound baseline the poll loop publishes per turn.
 * The reply route identifies which request a send answers, while the baseline
 * distinguishes several turns at that same address. With no baseline published
 * there is nothing to scope to, and envelope groups keep their existing
 * behaviour.
 */
describe('send_message MCP tool — tools-only turn budget', () => {
  const TEXT = 'the deploy finished, all four checks green';

  it('writes one row and refuses the repeat when the same text is sent twice in a turn', async () => {
    deliveryMode = 'tools-only';
    publishTurnBaseline(0);

    const first = await sendMessage.handler({ to: 'peer', text: TEXT });
    const second = await sendMessage.handler({ to: 'peer', text: TEXT });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe(TEXT);

    expect(resultText(first)).toContain(`(id: ${out[0].seq})`);
    expect(resultText(first)).toContain('Stop this turn now');
    expect(second.isError).toBeFalsy();
    expect(resultText(second)).toContain('Not sent');
    expect(resultText(second)).toContain('Do not retry, rephrase');
    expect(resultText(second)).toContain(`(id: ${out[0].seq})`);
  });

  it('treats a whitespace-only variation as the same message', async () => {
    deliveryMode = 'tools-only';
    publishTurnBaseline(0);

    await sendMessage.handler({ to: 'peer', text: TEXT });
    const second = await sendMessage.handler({ to: 'peer', text: `${TEXT}  \n` });

    expect(getUndeliveredMessages()).toHaveLength(1);
    expect(resultText(second)).toContain('Not sent');
  });

  it('refuses a paraphrased second message to the same destination', async () => {
    deliveryMode = 'tools-only';
    publishTurnBaseline(0);

    await sendMessage.handler({ to: 'peer', text: TEXT });
    const second = await sendMessage.handler({ to: 'peer', text: `${TEXT}, and the rollout is next` });

    expect(getUndeliveredMessages()).toHaveLength(1);
    expect(resultText(second)).toContain('Not sent');
    expect(resultText(second)).toContain('Stop this turn now');
  });

  it('lets the same text through to a different destination', async () => {
    deliveryMode = 'tools-only';
    publishTurnBaseline(0);

    await sendMessage.handler({ to: 'peer', text: TEXT });
    const second = await sendMessage.handler({ to: 'other-peer', text: TEXT });

    expect(getUndeliveredMessages()).toHaveLength(2);
    expect(resultText(second)).toContain('Message sent');
  });

  it('lets the same text through once a follow-up moves the baseline', async () => {
    deliveryMode = 'tools-only';
    publishTurnBaseline(0);
    await sendMessage.handler({ to: 'peer', text: TEXT });

    // What the poll loop does when it pushes a follow-up batch into a query
    // that is still open: same query, new turn.
    publishTurnBaseline(getMaxOutboundSeq());
    const second = await sendMessage.handler({ to: 'peer', text: TEXT });

    expect(getUndeliveredMessages()).toHaveLength(2);
    expect(resultText(second)).toContain('Message sent');
  });

  it('ignores an identical row written before the turn began', async () => {
    deliveryMode = 'tools-only';
    // A send from an earlier turn, already on file when this turn starts.
    writeMessageOut({
      id: 'msg-earlier-turn',
      kind: 'chat',
      platform_id: 'ag-peer',
      channel_type: 'agent',
      thread_id: null,
      content: JSON.stringify({ text: TEXT }),
    });
    publishTurnBaseline(getMaxOutboundSeq());

    const result = await sendMessage.handler({ to: 'peer', text: TEXT });

    expect(getUndeliveredMessages()).toHaveLength(2);
    expect(resultText(result)).toContain('Message sent');
  });

  it('leaves envelope groups alone', async () => {
    // deliveryMode stays at the default from beforeEach.
    publishTurnBaseline(0);

    await sendMessage.handler({ to: 'peer', text: TEXT });
    const second = await sendMessage.handler({ to: 'peer', text: TEXT });

    expect(getUndeliveredMessages()).toHaveLength(2);
    expect(resultText(second)).toContain('Message sent');
    expect(resultText(second)).not.toContain('Stop this turn');
  });

  it('does not suppress anything when no turn baseline is published', async () => {
    deliveryMode = 'tools-only';
    // No baseline: an ad-hoc invocation outside a batch has no turn to dedupe within.

    await sendMessage.handler({ to: 'peer', text: TEXT });
    const second = await sendMessage.handler({ to: 'peer', text: TEXT });

    expect(getUndeliveredMessages()).toHaveLength(2);
    expect(resultText(second)).toContain('Message sent');
  });
});
