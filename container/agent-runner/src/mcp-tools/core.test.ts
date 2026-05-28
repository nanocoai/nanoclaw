/**
 * Tests for the core MCP tools' interaction with the per-batch routing
 * context. The agent-runner sets a current `inReplyTo` at the top of each
 * batch in poll-loop, and outbound writes from MCP tools (send_message,
 * send_file) must pick it up so a2a return-path routing on the host can
 * correlate replies back to the originating session.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { setCurrentInReplyTo, clearCurrentInReplyTo } from '../current-batch.js';
import { queryReactions, sendMessage } from './core.js';

beforeEach(() => {
  initTestSessionDb();
  // Seed a peer agent destination
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

function insertReactionRow(
  id: string,
  timestamp: string,
  reaction: { emoji: string; rawEmoji: string; added: boolean; targetMessageId: string; userId: string },
  sender: string = 'John',
): void {
  const content = JSON.stringify({
    text: `[${sender} reacted ${reaction.emoji} on message ${reaction.targetMessageId}]`,
    sender,
    senderId: reaction.userId,
    reaction,
  });
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, content)
       VALUES (?, 'chat-sdk', ?, 'pending', ?)`,
    )
    .run(id, timestamp, content);
}

describe('query_reactions MCP tool', () => {
  it('returns "no reactions" when the session has none', async () => {
    const result = await queryReactions.handler({});
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('No reactions');
  });

  it('lists all reactions in the session when no filter is given', async () => {
    insertReactionRow('rxn-1', '2026-05-22T10:00:00Z', {
      emoji: '👍',
      rawEmoji: '+1',
      added: true,
      targetMessageId: 'ts-1',
      userId: 'U1',
    });
    insertReactionRow('rxn-2', '2026-05-22T11:00:00Z', {
      emoji: '❤️',
      rawEmoji: 'heart',
      added: true,
      targetMessageId: 'ts-2',
      userId: 'U2',
    });
    const result = await queryReactions.handler({});
    const text = result.content[0].text as string;
    expect(text).toContain('"count": 2');
    expect(text).toContain('"emoji": "👍"');
    expect(text).toContain('"emoji": "❤️"');
  });

  it('filters by target_message_id', async () => {
    insertReactionRow('rxn-1', '2026-05-22T10:00:00Z', {
      emoji: '👍',
      rawEmoji: '+1',
      added: true,
      targetMessageId: 'ts-A',
      userId: 'U1',
    });
    insertReactionRow('rxn-2', '2026-05-22T11:00:00Z', {
      emoji: '❤️',
      rawEmoji: 'heart',
      added: true,
      targetMessageId: 'ts-B',
      userId: 'U2',
    });
    const result = await queryReactions.handler({ target_message_id: 'ts-A' });
    const text = result.content[0].text as string;
    expect(text).toContain('"count": 1');
    expect(text).toContain('ts-A');
    expect(text).not.toContain('ts-B');
  });

  it('preserves added=false (reaction removals)', async () => {
    insertReactionRow('rxn-1', '2026-05-22T10:00:00Z', {
      emoji: '👍',
      rawEmoji: '+1',
      added: false,
      targetMessageId: 'ts-1',
      userId: 'U1',
    });
    const result = await queryReactions.handler({});
    const text = result.content[0].text as string;
    expect(text).toContain('"added": false');
  });

  it('honors limit (orders newest-first)', async () => {
    for (let i = 0; i < 5; i++) {
      const ts = `2026-05-22T10:0${i}:00Z`;
      insertReactionRow(`rxn-${i}`, ts, {
        emoji: '⭐',
        rawEmoji: 'star',
        added: true,
        targetMessageId: `ts-${i}`,
        userId: 'U1',
      });
    }
    const result = await queryReactions.handler({ limit: 2 });
    const text = result.content[0].text as string;
    expect(text).toContain('"count": 2');
    // newest first: ts-4 and ts-3
    expect(text).toContain('ts-4');
    expect(text).toContain('ts-3');
    expect(text).not.toContain('ts-0');
  });

  it('ignores non-reaction chat-sdk rows', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES (?, 'chat-sdk', ?, 'pending', ?)`,
      )
      .run('plain-1', '2026-05-22T09:00:00Z', JSON.stringify({ text: 'hi', sender: 'Alice' }));
    const result = await queryReactions.handler({});
    expect(result.content[0].text).toContain('No reactions');
  });
});
