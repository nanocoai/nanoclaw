import { describe, expect, it } from 'vitest';

import { unwrapForwardedSnapshot } from './discord.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function forwardPayload(snapshotMessage: Record<string, any> | null, overrides: Record<string, any> = {}) {
  return {
    id: '123',
    content: '',
    attachments: [],
    message_reference: { type: 1, channel_id: 'c1', message_id: 'm1' },
    ...(snapshotMessage ? { message_snapshots: [{ message: snapshotMessage }] } : {}),
    ...overrides,
  };
}

describe('unwrapForwardedSnapshot', () => {
  it('unwraps forwarded text into content with a label', () => {
    const data = forwardPayload({ content: 'hello from the past', attachments: [] });
    unwrapForwardedSnapshot(data);
    expect(data.content).toBe('[Forwarded message]\nhello from the past');
  });

  it('unwraps attachment-only forwards: label + merged attachments', () => {
    const att = { filename: 'photo.png', content_type: 'image/png', size: 1234, url: 'https://cdn.example/photo.png' };
    const data = forwardPayload({ content: '', attachments: [att] });
    unwrapForwardedSnapshot(data);
    expect(data.content).toBe('[Forwarded message]');
    expect(data.attachments).toEqual([att]);
  });

  it('merges snapshot attachments after existing ones', () => {
    const existing = { filename: 'own.txt', content_type: 'text/plain', size: 1, url: 'https://cdn.example/own.txt' };
    const fwd = { filename: 'fwd.jpg', content_type: 'image/jpeg', size: 2, url: 'https://cdn.example/fwd.jpg' };
    const data = forwardPayload({ content: 'look', attachments: [fwd] }, { attachments: [existing] });
    unwrapForwardedSnapshot(data);
    expect(data.attachments).toEqual([existing, fwd]);
    expect(data.content).toBe('[Forwarded message]\nlook');
  });

  it('leaves plain messages untouched', () => {
    const data = { id: '1', content: 'hi', attachments: [] };
    unwrapForwardedSnapshot(data);
    expect(data).toEqual({ id: '1', content: 'hi', attachments: [] });
  });

  it('leaves normal replies (type 0) untouched', () => {
    const data = {
      id: '1',
      content: 'a reply',
      attachments: [],
      message_reference: { type: 0, message_id: 'm0' },
      referenced_message: { content: 'original', author: { username: 'alice' } },
    };
    unwrapForwardedSnapshot(data);
    expect(data.content).toBe('a reply');
  });

  it('is a no-op when a forward has no snapshots', () => {
    const data = forwardPayload(null);
    unwrapForwardedSnapshot(data);
    expect(data.content).toBe('');
    expect(data.attachments).toEqual([]);
  });

  it('joins multiple snapshots', () => {
    const data = forwardPayload(null, {
      message_snapshots: [
        { message: { content: 'one', attachments: [] } },
        { message: { content: 'two', attachments: [] } },
      ],
    });
    unwrapForwardedSnapshot(data);
    expect(data.content).toBe('[Forwarded message]\none\ntwo');
  });
});
