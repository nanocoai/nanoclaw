/**
 * Regression tests for cross-channel reply misrouting (a reply to a
 * Telegram-triggered batch was delivered to WhatsApp).
 *
 * Two guarantees:
 *   1. extractRouting anchors on the batch's triggering (trigger=1)
 *      message, not on accumulated trigger=0 context that happens to sit
 *      first in the batch.
 *   2. send_message with no explicit `to` defaults to the current batch's
 *      triggering-message routing, not the session's sticky first-channel
 *      session_routing row.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import {
  clearCurrentInReplyTo,
  setCurrentInReplyTo,
  setCurrentRouting,
} from './current-batch.js';
import { extractRouting } from './formatter.js';
import { sendMessage } from './mcp-tools/core.js';
import type { MessageInRow } from './db/messages-in.js';

function row(overrides: Partial<MessageInRow>): MessageInRow {
  return {
    id: 'm-x',
    seq: null,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    status: 'pending',
    process_after: null,
    recurrence: null,
    tries: 0,
    trigger: 1,
    platform_id: null,
    channel_type: null,
    thread_id: null,
    content: '{}',
    ...overrides,
  };
}

describe('extractRouting — trigger anchoring', () => {
  it('anchors on the latest trigger=1 message, not the first row in the batch', () => {
    const batch = [
      row({ id: 'wa-1', trigger: 0, channel_type: 'whatsapp', platform_id: 'group-xyz' }),
      row({ id: 'wa-2', trigger: 0, channel_type: 'whatsapp', platform_id: 'group-xyz' }),
      row({ id: 'tg-1', trigger: 1, channel_type: 'telegram', platform_id: '12345' }),
    ];
    const routing = extractRouting(batch);
    expect(routing.channelType).toBe('telegram');
    expect(routing.platformId).toBe('12345');
    expect(routing.inReplyTo).toBe('tg-1');
  });

  it('falls back to the first message when no trigger=1 row exists', () => {
    const batch = [row({ id: 'a', trigger: 0, channel_type: 'whatsapp', platform_id: 'g1' })];
    const routing = extractRouting(batch);
    expect(routing.channelType).toBe('whatsapp');
    expect(routing.inReplyTo).toBe('a');
  });
});

describe('send_message default destination', () => {
  beforeEach(() => {
    initTestSessionDb();
    // Sticky session routing points at WhatsApp (the messaging group the
    // session was created with).
    getInboundDb().exec(`
      CREATE TABLE session_routing (
        id           INTEGER PRIMARY KEY CHECK (id = 1),
        channel_type TEXT,
        platform_id  TEXT,
        thread_id    TEXT
      );
      INSERT INTO session_routing (id, channel_type, platform_id, thread_id)
      VALUES (1, 'whatsapp', 'group-xyz', NULL);
    `);
  });

  afterEach(() => {
    clearCurrentInReplyTo();
    setCurrentRouting(null);
    closeSessionDb();
  });

  it('replies to the triggering message channel, not the sticky session routing', async () => {
    setCurrentInReplyTo('tg-1');
    setCurrentRouting({ channelType: 'telegram', platformId: '12345', threadId: null });

    await sendMessage.handler({ text: 'reply' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('telegram');
    expect(out[0].platform_id).toBe('12345');
  });

  it('falls back to session routing when no batch routing is published', async () => {
    await sendMessage.handler({ text: 'reply' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('whatsapp');
    expect(out[0].platform_id).toBe('group-xyz');
  });
});
