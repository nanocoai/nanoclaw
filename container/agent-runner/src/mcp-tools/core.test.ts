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
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import fs from 'fs';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { sendFile, sendMessage } from './core.js';

/**
 * Publish the reply stamp the way the poll loop does: a direct write to
 * session_state in outbound.db.
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

beforeEach(() => {
  initTestSessionDb();
  hostSeq = 0;
  // Seed a peer agent destination
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('peer', 'Peer', 'agent', NULL, NULL, 'ag-peer')`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

describe('send_message MCP tool — in_reply_to plumbing', () => {
  it('stamps the answered message (published via the DB) on a reply to the agent that asked', async () => {
    publishReplyRoute({ inReplyTo: 'inbound-msg-1', channelType: 'agent', platformId: 'ag-peer' });

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
    publishReplyRoute({ inReplyTo: 'inbound-msg-1', channelType: 'agent', platformId: 'ag-peer' }, 3 * 60 * 60 * 1000); // three hours into the turn

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

describe('send_message / send_file — in_reply_to for an agent destination', () => {
  // The host routes an a2a message to the session that sent the row named by
  // in_reply_to (src/modules/agent-to-agent/agent-route.ts), so an agent
  // destination may only carry the turn's stamp when the turn is answering
  // that same agent. Otherwise the stamp is null and the host picks the
  // session by peer affinity (the session of that agent that last wrote here).
  let fsSpies: Array<{ mockRestore(): void }> = [];

  beforeEach(() => {
    fsSpies = [
      spyOn(fs, 'existsSync').mockReturnValue(true),
      spyOn(fs, 'mkdirSync').mockReturnValue(undefined),
      spyOn(fs, 'copyFileSync').mockReturnValue(undefined),
    ];
  });

  afterEach(() => {
    for (const spy of fsSpies) spy.mockRestore();
  });

  async function sendBothToPeer(): Promise<Array<string | null>> {
    const msg = (await sendMessage.handler({ to: 'peer', text: 'hello' })) as { isError?: boolean };
    expect(msg.isError).toBeUndefined();
    const file = (await sendFile.handler({ to: 'peer', path: '/tmp/report.txt' })) as { isError?: boolean };
    expect(file.isError).toBeUndefined();
    return getUndeliveredMessages().map((m) => m.in_reply_to);
  }

  it("relay: a turn started by another agent's message never stamps that agent's message", async () => {
    // peer asked us; we asked a third agent; its answer started this turn and
    // we pass the answer on to peer. Stamping the third agent's message sent
    // the host to one of the third agent's sessions, and the answer landed in
    // peer's newest session instead of the one that asked.
    seedInbound('a2a-from-peer', 'agent', 'ag-peer', null);
    seedInbound('a2a-from-third', 'agent', 'ag-third', null);
    publishReplyRoute({ inReplyTo: 'a2a-from-third', channelType: 'agent', platformId: 'ag-third' });

    expect(await sendBothToPeer()).toEqual([null, null]);
  });

  it('a reply to the agent whose message started the turn stamps that message, even if a newer one arrived mid-turn', async () => {
    seedInbound('a2a-question', 'agent', 'ag-peer', null);
    seedInbound('a2a-followup', 'agent', 'ag-peer', null);
    publishReplyRoute({ inReplyTo: 'a2a-question', channelType: 'agent', platformId: 'ag-peer' });

    expect(await sendBothToPeer()).toEqual(['a2a-question', 'a2a-question']);
  });

  it('a new request to an agent from a turn answering a chat never stamps the chat message', async () => {
    seedInbound('a2a-old-from-peer', 'agent', 'ag-peer', null);
    seedInbound('chat-1', 'slack', 'C999', null);
    publishReplyRoute({ inReplyTo: 'chat-1', channelType: 'slack', platformId: 'C999' });

    expect(await sendBothToPeer()).toEqual([null, null]);
  });

  it('writes null to an agent when no turn is active', async () => {
    seedInbound('a2a-old-from-peer', 'agent', 'ag-peer', null);

    expect(await sendBothToPeer()).toEqual([null, null]);
  });
});

describe('send_message / send_file — in_reply_to for a channel destination', () => {
  // Adapters read in_reply_to to thread mail and to quote, so a channel send
  // keeps the turn's stamp: never the destination's own latest row, which
  // would join or quote a conversation the message does not answer.
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

  async function sendBoth(to: string): Promise<Array<string | null>> {
    const msg = (await sendMessage.handler({ to, text: 'hello' })) as { isError?: boolean };
    expect(msg.isError).toBeUndefined();
    const file = (await sendFile.handler({ to, path: '/tmp/report.txt' })) as { isError?: boolean };
    expect(file.isError).toBeUndefined();
    return getUndeliveredMessages().map((m) => m.in_reply_to);
  }

  it('a reply to the channel being answered stamps the answered message', async () => {
    seedInbound('in-1', 'slack', 'C123', null);
    seedInbound('in-2', 'slack', 'C123', null);
    publishReplyRoute({ inReplyTo: 'in-1', channelType: 'slack', platformId: 'C123' });

    expect(await sendBoth('current-chat')).toEqual(['in-1', 'in-1']);
  });

  it("a send to another channel keeps the turn's stamp, not that channel's latest message", async () => {
    seedInbound('slack-old', 'slack', 'C123', null);
    seedInbound('discord-1', 'discord', 'chan-9', null);
    publishReplyRoute({ inReplyTo: 'discord-1', channelType: 'discord', platformId: 'chan-9' });

    expect(await sendBoth('current-chat')).toEqual(['discord-1', 'discord-1']);
  });

  it('a send outside a turn writes null, never the latest inbound message', async () => {
    seedInbound('slack-old', 'slack', 'C123', null);

    expect(await sendBoth('current-chat')).toEqual([null, null]);
  });

  it('a mail sent from a chat turn never names the last inbound mail (it would join that thread as a reply)', async () => {
    seedChannelDestination('work-email', 'email', 'someone@example.com');
    seedInbound('mail-old-thread', 'email', 'someone@example.com', null);
    seedInbound('chat-1', 'slack', 'C999', null);
    publishReplyRoute({ inReplyTo: 'chat-1', channelType: 'slack', platformId: 'C999' });

    expect(await sendBoth('work-email')).toEqual(['chat-1', 'chat-1']);
  });
});
