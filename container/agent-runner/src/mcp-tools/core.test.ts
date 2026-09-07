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
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { sendFile, sendMessage } from './core.js';

/**
 * Publish the a2a reply stamp the way the poll loop does: a direct write to
 * session_state in outbound.db. `ageMs` back-dates updated_at to exercise the
 * staleness guard MCP tools apply when reading it.
 */
function publishInReplyTo(id: string, ageMs = 0): void {
  const updatedAt = new Date(Date.now() - ageMs).toISOString();
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('current_in_reply_to', id, updatedAt);
}

/** The session's bound chat/thread, as the host writes it on every wake. */
function seedSessionRouting(channelType: string | null, platformId: string | null, threadId: string | null): void {
  const db = getInboundDb();
  db.exec(`CREATE TABLE IF NOT EXISTS session_routing (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    channel_type TEXT, platform_id TEXT, thread_id TEXT
  )`);
  db.prepare(
    'INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, ?, ?, ?)',
  ).run(channelType, platformId, threadId);
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

  it('ignores a stale stamp left behind by a killed container', async () => {
    publishInReplyTo('inbound-msg-1', 60 * 60 * 1000); // an hour old

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });
});

describe('send_message / send_file — thread for a channel destination', () => {
  let tmp: string;
  let prevOutbox: string | undefined;
  let filePath: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'core-send-'));
    prevOutbox = process.env.NANOCLAW_OUTBOX_DIR;
    process.env.NANOCLAW_OUTBOX_DIR = path.join(tmp, 'outbox');
    filePath = path.join(tmp, 'report.txt');
    fs.writeFileSync(filePath, 'report');
    seedChannelDestination('current-chat', 'slack', 'C123');
  });

  afterEach(() => {
    if (prevOutbox === undefined) delete process.env.NANOCLAW_OUTBOX_DIR;
    else process.env.NANOCLAW_OUTBOX_DIR = prevOutbox;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('send_message lands in the latest thread the channel is in when the session thread is null', async () => {
    // A shared or agent-shared session (or a DM sub-thread) is bound to the
    // channel with no thread of its own — but the request came in a thread.
    seedSessionRouting('slack', 'C123', null);
    seedInbound('in-1', 'slack', 'C123', 'T-1');
    seedInbound('in-2', 'slack', 'C123', 'T-42');

    await sendMessage.handler({ to: 'current-chat', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('C123');
    expect(out[0].thread_id).toBe('T-42');
  });

  it('send_file lands in the thread the request arrived in when the session thread is null', async () => {
    seedSessionRouting('slack', 'C123', null);
    seedInbound('in-1', 'slack', 'C123', 'T-42');

    const result = (await sendFile.handler({ to: 'current-chat', path: filePath })) as { isError?: boolean };
    expect(result.isError).toBeUndefined();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('C123');
    expect(out[0].thread_id).toBe('T-42');
  });

  it("never reads the session's bound thread, which can be stale or null", async () => {
    // The bound thread is what the tools used to read. Even when it is set, the
    // conversation's current thread is the one the inbound row carries.
    seedSessionRouting('slack', 'C123', 'T-bound');
    seedInbound('in-1', 'slack', 'C123', 'T-42');

    await sendMessage.handler({ to: 'current-chat', text: 'hello' });
    await sendFile.handler({ to: 'current-chat', path: filePath });

    expect(getUndeliveredMessages().map((m) => m.thread_id)).toEqual(['T-42', 'T-42']);
  });

  it("does not stamp another channel's thread onto a destination nothing arrived from", async () => {
    // agent-shared session: the latest inbound row is from discord, the send
    // goes to slack. Slack has no thread context, so it must not inherit one.
    seedChannelDestination('other-chat', 'discord', 'chan-9');
    seedSessionRouting('discord', 'chan-9', null);
    seedInbound('in-1', 'discord', 'chan-9', 'discord-thread');

    await sendMessage.handler({ to: 'current-chat', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('C123');
    expect(out[0].thread_id).toBeNull();
  });

  it('sends unthreaded when nothing has arrived from the channel yet', async () => {
    // Same as the poll loop's text-reply path: no inbound row, no thread.
    seedSessionRouting('slack', 'C123', 'T-bound');

    await sendMessage.handler({ to: 'current-chat', text: 'hello' });
    await sendFile.handler({ to: 'current-chat', path: filePath });

    expect(getUndeliveredMessages().map((m) => m.thread_id)).toEqual([null, null]);
  });
});
