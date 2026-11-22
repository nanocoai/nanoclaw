import { describe, expect, it } from 'vitest';

import { extractReplyContext } from './telegram.js';

describe('extractReplyContext', () => {
  it('returns the replied message', () => {
    expect(extractReplyContext({ reply_to_message: { text: 'hi', from: { first_name: 'Bob' } } })).toEqual({
      text: 'hi',
      sender: 'Bob',
    });
  });

  it('keeps the selected part of a partial quote', () => {
    const raw = {
      reply_to_message: { text: 'one. two.', from: { first_name: 'Nano' } },
      quote: { text: 'two.', position: 5 },
    };
    expect(extractReplyContext(raw)).toEqual({ text: 'one. two.', sender: 'Nano', quote: 'two.' });
  });

  it('ignores the implicit reply to a forum topic creation message', () => {
    const raw = { reply_to_message: { forum_topic_created: { name: 't' }, from: { first_name: 'Bob' } } };
    expect(extractReplyContext(raw)).toBeNull();
  });

  it('uses the quote of a reply to a message from another chat', () => {
    const raw = {
      external_reply: { origin: { type: 'channel', chat: { title: 'News' } } },
      quote: { text: 'headline', position: 0 },
    };
    expect(extractReplyContext(raw)).toEqual({ text: 'headline', sender: 'News', quote: 'headline' });
  });

  it('returns null without a reply', () => {
    expect(extractReplyContext({ text: 'plain' })).toBeNull();
  });
});
