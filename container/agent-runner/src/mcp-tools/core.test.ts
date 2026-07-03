/**
 * Tests for core MCP tool DB plumbing.
 *
 * The agent-runner sets a current `inReplyTo` at the top of each batch in
 * poll-loop, and outbound writes from MCP tools must preserve that routing.
 * Message action tools also resolve agent-facing numeric IDs to raw platform
 * IDs before queuing edit/reaction operations.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { setCurrentInReplyTo, clearCurrentInReplyTo } from '../current-batch.js';
import { initTestSessionDb, closeSessionDb, getInboundDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { sendMessage, addReaction, editMessage } from './core.js';

beforeEach(() => {
  initTestSessionDb();
  // Seed a peer agent destination.
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('peer', 'Peer', 'agent', NULL, NULL, 'ag-peer')`,
    )
    .run();
});

afterEach(() => {
  clearCurrentInReplyTo();
  closeSessionDb();
});

function insertInboundMessage(opts: {
  seq: number;
  id: string;
  platformMessageId?: string | null;
  channelType?: string | null;
  platformId?: string | null;
  threadId?: string | null;
}): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (
        id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content, platform_message_id
      )
      VALUES (?, ?, 'chat', datetime('now'), 'pending', ?, ?, ?, '{}', ?)`,
    )
    .run(
      opts.id,
      opts.seq,
      opts.platformId ?? '987654321098765432',
      opts.channelType ?? 'discord',
      opts.threadId ?? null,
      opts.platformMessageId ?? null,
    );
}

describe('send_message MCP tool — in_reply_to plumbing', () => {
  it('stamps current batch in_reply_to on outbound rows', async () => {
    setCurrentInReplyTo('inbound-msg-1');

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('inbound-msg-1');
  });

  it('writes null when no batch is active', async () => {
    // No setCurrentInReplyTo before this call — simulates ad-hoc / out-of-batch invocation.
    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });
});

describe('core message action tools', () => {
  it('uses the raw platform message ID when reacting to a routed inbound message', async () => {
    insertInboundMessage({
      seq: 4,
      id: '111122223333444455:ag-discord-test-agent',
      platformMessageId: '111122223333444455',
    });

    const result = await addReaction.handler({ messageId: 4, emoji: 'clock3' });
    expect(result.isError).toBeUndefined();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content)).toEqual({
      operation: 'reaction',
      messageId: '111122223333444455',
      emoji: 'clock3',
    });
  });

  it('rejects edits targeting inbound user messages', async () => {
    insertInboundMessage({
      seq: 4,
      id: '111122223333444455:ag-discord-test-agent',
      platformMessageId: '111122223333444455',
    });

    const result = await editMessage.handler({ messageId: 4, text: 'updated text' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Cannot edit inbound message #4');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});
