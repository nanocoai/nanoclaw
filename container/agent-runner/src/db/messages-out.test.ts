import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getOutboundDb, initTestSessionDb } from './connection.js';
import { getUndeliveredMessages, writeChatMessageOnce } from './messages-out.js';

function chat(id: string, text: string, platformId = 'mouse-chat'): Parameters<typeof writeChatMessageOnce>[0] {
  return {
    id,
    in_reply_to: 'in-1',
    channel_type: 'mouse',
    platform_id: platformId,
    thread_id: 'thread-1',
    text,
  };
}

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('turn-scoped chat delivery claims', () => {
  it('writes equivalent chat content only once within one inbound turn', () => {
    const first = writeChatMessageOnce(chat('mcp-id', '  Done.\r\n'), 'turn-1', 'mcp');
    const duplicate = writeChatMessageOnce(chat('final-id', 'Done.'), 'turn-1', 'final');

    expect(first.inserted).toBe(true);
    expect(duplicate).toEqual({ id: 'mcp-id', seq: first.seq, inserted: false });
    expect(getUndeliveredMessages()).toHaveLength(1);
    expect(getOutboundDb().prepare('SELECT source FROM message_delivery_claims').get() as { source: string }).toEqual({
      source: 'mcp',
    });
  });

  it('allows the same content on a later inbound turn', () => {
    writeChatMessageOnce(chat('turn-1-id', 'Done.'), 'turn-1', 'final');
    writeChatMessageOnce(chat('turn-2-id', 'Done.'), 'turn-2', 'final');

    expect(getUndeliveredMessages().map((row) => row.id)).toEqual(['turn-1-id', 'turn-2-id']);
  });

  it('allows distinct updates and destinations within one turn', () => {
    writeChatMessageOnce(chat('ack', 'On it.'), 'turn-1', 'mcp');
    writeChatMessageOnce(chat('final', 'Done.'), 'turn-1', 'final');
    writeChatMessageOnce(chat('other-destination', 'Done.', 'ops-chat'), 'turn-1', 'final');

    expect(getUndeliveredMessages()).toHaveLength(3);
  });

  it('reuses a durable pre-existing claim after a retry', () => {
    const original = writeChatMessageOnce(chat('before-crash', 'Recovered.'), 'turn-1', 'mcp');
    const retry = writeChatMessageOnce(chat('after-restart', 'Recovered.'), 'turn-1', 'final');

    expect(retry).toEqual({ id: 'before-crash', seq: original.seq, inserted: false });
    expect(getUndeliveredMessages()).toHaveLength(1);
  });
});
