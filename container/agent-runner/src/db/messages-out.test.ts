/**
 * Tests for the idempotent-outbound guard in writeMessageOut.
 *
 * The same reply can reach writeMessageOut via several paths in one turn
 * (send_message MCP tool, <message> block dispatch, post-nudge re-send).
 * The guard must collapse those into a single outbound row — the
 * "triple message" bug — while never touching scheduled/recurring rows
 * or distinct messages.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb } from './connection.js';
import {
  writeMessageOut,
  getUndeliveredMessages,
  getMaxOutSeq,
  countChatSendsSince,
} from './messages-out.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function chatMsg(id: string, text: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'chat',
    platform_id: 'telegram:123',
    channel_type: 'telegram',
    content: JSON.stringify({ text }),
    ...overrides,
  };
}

describe('writeMessageOut — idempotent outbound', () => {
  it('skips an identical chat message sent twice in quick succession', () => {
    const seq1 = writeMessageOut(chatMsg('m1', 'hello'));
    const seq2 = writeMessageOut(chatMsg('m2', 'hello'));

    expect(seq2).toBe(seq1); // same agent-facing id, no second row
    expect(getUndeliveredMessages()).toHaveLength(1);
  });

  it('collapses a triple send (MCP + block + nudge re-send) into one row', () => {
    writeMessageOut(chatMsg('m1', 'welcome!'));
    writeMessageOut(chatMsg('m2', 'welcome!'));
    writeMessageOut(chatMsg('m3', 'welcome!'));

    expect(getUndeliveredMessages()).toHaveLength(1);
  });

  it('does not dedup distinct texts', () => {
    writeMessageOut(chatMsg('m1', 'first'));
    writeMessageOut(chatMsg('m2', 'second'));

    expect(getUndeliveredMessages()).toHaveLength(2);
  });

  it('does not dedup across different destinations', () => {
    writeMessageOut(chatMsg('m1', 'hello'));
    writeMessageOut(chatMsg('m2', 'hello', { platform_id: 'telegram:456' }));

    expect(getUndeliveredMessages()).toHaveLength(2);
  });

  it('never dedups scheduled or recurring messages', () => {
    const future = '2099-01-01 00:00:00';
    writeMessageOut(chatMsg('m1', 'reminder', { deliver_after: future }));
    writeMessageOut(chatMsg('m2', 'reminder', { deliver_after: future }));

    // Both rows exist (deliver_after in the future filters them out of
    // getUndeliveredMessages, so count rows via seq movement instead).
    expect(getMaxOutSeq()).toBeGreaterThanOrEqual(3); // two odd seqs assigned
  });

  it('never dedups non-chat kinds', () => {
    writeMessageOut(chatMsg('m1', 'x', { kind: 'system' }));
    writeMessageOut(chatMsg('m2', 'x', { kind: 'system' }));

    expect(getUndeliveredMessages()).toHaveLength(2);
  });
});

describe('countChatSendsSince — nudge suppression helper', () => {
  it('reports zero when nothing was sent after the snapshot', () => {
    writeMessageOut(chatMsg('m1', 'before'));
    const mark = getMaxOutSeq();

    expect(countChatSendsSince(mark)).toBe(0);
  });

  it('counts chat sends written after the snapshot', () => {
    const mark = getMaxOutSeq();
    writeMessageOut(chatMsg('m1', 'mid-turn update'));

    expect(countChatSendsSince(mark)).toBe(1);
  });

  it('ignores scheduled messages written after the snapshot', () => {
    const mark = getMaxOutSeq();
    writeMessageOut(chatMsg('m1', 'reminder', { deliver_after: '2099-01-01 00:00:00' }));

    expect(countChatSendsSince(mark)).toBe(0);
  });
});
