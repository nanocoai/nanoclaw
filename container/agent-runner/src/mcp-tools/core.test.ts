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
