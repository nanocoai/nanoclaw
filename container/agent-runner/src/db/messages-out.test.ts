import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

mock.module('../config.js', () => ({
  loadConfig: () => ({ agentGroupId: 'ag-1111111111111-aaaaaa' }),
}));

import { closeSessionDb, getInboundDb, initTestSessionDb } from './connection.js';
import { getMessageIdBySeq, stripAgentGroupSuffix } from './messages-out.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function seedInbound(id: string, seq: number): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, content) VALUES (?, ?, 'text', '2026-01-01T00:00:00Z', '{}')`,
    )
    .run(id, seq);
}

describe('stripAgentGroupSuffix', () => {
  it('strips a bare Slack-style timestamp suffix', () => {
    expect(stripAgentGroupSuffix('1234567890.123456:ag-1111111111111-aaaaaa', 'ag-1111111111111-aaaaaa')).toBe(
      '1234567890.123456',
    );
  });

  it('strips the suffix off an id that itself contains a colon (Telegram chatId:messageId)', () => {
    expect(stripAgentGroupSuffix('6037840640:42:ag-1111111111111-aaaaaa', 'ag-1111111111111-aaaaaa')).toBe(
      '6037840640:42',
    );
  });

  it('leaves an id without the suffix untouched', () => {
    expect(stripAgentGroupSuffix('1234567890.123456', 'ag-1111111111111-aaaaaa')).toBe('1234567890.123456');
  });

  it('does not strip when the agent group id does not match the suffix', () => {
    expect(stripAgentGroupSuffix('1234567890.123456:ag-other', 'ag-1111111111111-aaaaaa')).toBe(
      '1234567890.123456:ag-other',
    );
  });

  it('returns the id unchanged when agentGroupId is empty', () => {
    expect(stripAgentGroupSuffix('1234567890.123456:ag-1111111111111-aaaaaa', '')).toBe(
      '1234567890.123456:ag-1111111111111-aaaaaa',
    );
  });
});

describe('getMessageIdBySeq — inbound suffix stripping', () => {
  it('returns the bare platform id for an inbound row, round-trippable to addReaction/editMessage', () => {
    seedInbound('1234567890.123456:ag-1111111111111-aaaaaa', 7);

    expect(getMessageIdBySeq(7)).toBe('1234567890.123456');
  });

  it('correctly strips the suffix from a Telegram-style id containing its own colon', () => {
    seedInbound('6037840640:42:ag-1111111111111-aaaaaa', 9);

    expect(getMessageIdBySeq(9)).toBe('6037840640:42');
  });
});
