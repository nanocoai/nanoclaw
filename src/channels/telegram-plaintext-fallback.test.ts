/**
 * When Telegram rejects a reply's MarkdownV2 entities ("can't parse
 * entities"), plain chat text is re-sent unformatted instead of being retried
 * and dropped. Kill condition: drop the fallback in deliver and the reply is
 * lost; drop the operation/type/files guards in plainTextFallback and
 * reactions, cards or file sends get re-sent as bare text ("only plain chat
 * text" goes red).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isEntityParseError, plainTextFallback, sendPlainText } from './telegram.js';

afterEach(() => vi.unstubAllGlobals());

describe('telegram plain-text fallback', () => {
  it('recognises the entity parse error', () => {
    expect(isEntityParseError(new Error("Bad Request: can't parse entities: Character '.' is reserved"))).toBe(true);
    expect(isEntityParseError(new Error('Bad Request: message is too long'))).toBe(false);
  });

  it('falls back only for plain chat text', () => {
    expect(plainTextFallback({ kind: 'chat', content: { text: 'see http://10.0.0.1' } })).toBe('see http://10.0.0.1');
    expect(plainTextFallback({ kind: 'chat', content: { operation: 'reaction', emoji: '👍' } })).toBeNull();
    expect(plainTextFallback({ kind: 'chat', content: { type: 'ask_question', text: 'q' } })).toBeNull();
    expect(
      plainTextFallback({ kind: 'chat', content: { text: 'x' }, files: [{ filename: 'a', data: Buffer.from('') }] }),
    ).toBeNull();
  });

  it('sends into the forum topic and returns the composite id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => ({ ok: true, result: { message_id: 9 } }) });
    vi.stubGlobal('fetch', fetchMock);
    expect(await sendPlainText('tok', 'telegram:-100', 'telegram:-100:7', 'hi')).toBe('-100:9');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ chat_id: '-100', text: 'hi', message_thread_id: 7 });
  });
});
