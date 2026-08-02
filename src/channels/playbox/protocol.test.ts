import { describe, expect, it } from 'vitest';

import { parsePlayboxInbound } from './protocol.js';

const valid = {
  id: 'm1',
  senderId: 'playbox:alice',
  senderName: 'Alice',
  text: 'expense: coffee 35',
  timestamp: '2026-08-02T10:00:00.000Z',
  attachments: [],
};

describe('playbox protocol', () => {
  it('preserves sender and reply metadata', () => {
    expect(parsePlayboxInbound({ ...valid, replyToId: 'agent-1' })).toMatchObject({
      senderId: 'playbox:alice',
      senderName: 'Alice',
      replyToId: 'agent-1',
    });
  });

  it('rejects invalid base64, MIME types, and oversized attachments', () => {
    expect(() =>
      parsePlayboxInbound({ ...valid, attachments: [{ name: 'x.jpg', type: 'image/jpeg', dataBase64: '***' }] }),
    ).toThrow();
    expect(() =>
      parsePlayboxInbound({ ...valid, attachments: [{ name: 'x.txt', type: 'text/plain', dataBase64: 'eA==' }] }),
    ).toThrow();
    expect(() =>
      parsePlayboxInbound({
        ...valid,
        attachments: [{ name: 'x.jpg', type: 'image/jpeg', dataBase64: 'A'.repeat(15 * 1024 * 1024) }],
      }),
    ).toThrow();
  });
});
