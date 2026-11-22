/**
 * Forum topics and private-chat topics are threads; a non-forum group's
 * message_thread_id (a reply-chain root) is folded back to the chat. Kill
 * conditions: drop the is_forum check in normalizeTopicThreadId and
 * "non-forum" goes red, so every reply chain in an ordinary group would open
 * its own session; keep `telegram:<user>` for a DM outside any topic and the
 * chat-level case goes red, so a per-thread DM wiring would abandon its
 * thread-less session.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { normalizeTopicThreadId } from './telegram.js';

function stubGetChat(isForum: boolean) {
  const fetchMock = vi.fn().mockResolvedValue({ json: async () => ({ ok: true, result: { is_forum: isForum } }) });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('normalizeTopicThreadId', () => {
  it('keeps the topic in a forum supergroup', async () => {
    stubGetChat(true);
    expect(await normalizeTopicThreadId('tok', 'telegram:-1001:42')).toBe('telegram:-1001:42');
  });

  it('folds a reply chain in a non-forum group back to the chat', async () => {
    stubGetChat(false);
    expect(await normalizeTopicThreadId('tok', 'telegram:-1002:42')).toBe('telegram:-1002');
  });

  it('leaves chat-level ids alone without a lookup; a DM outside any topic gets no thread id', async () => {
    const fetchMock = stubGetChat(true);
    expect(await normalizeTopicThreadId('tok', 'telegram:-1001')).toBe('telegram:-1001');
    expect(await normalizeTopicThreadId('tok', 'telegram:5')).toBeNull();
    expect(await normalizeTopicThreadId('tok', null)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caches is_forum per chat', async () => {
    const fetchMock = stubGetChat(true);
    await normalizeTopicThreadId('tok', 'telegram:-1003:1');
    await normalizeTopicThreadId('tok', 'telegram:-1003:2');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('private-chat topics', () => {
  function stubGetMe(result: unknown) {
    const fetchMock = vi.fn().mockImplementation(async () => ({ json: async () => result }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('keeps the topic while the bot has topics enabled', async () => {
    const fetchMock = stubGetMe({ ok: true, result: { has_topics_enabled: true } });
    expect(await normalizeTopicThreadId('tok-on', 'telegram:5:77')).toBe('telegram:5:77');
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/bottok-on\/getMe$/);
  });

  it('drops a stray thread id when the bot has topics disabled', async () => {
    stubGetMe({ ok: true, result: { has_topics_enabled: false } });
    expect(await normalizeTopicThreadId('tok-off', 'telegram:5:77')).toBeNull();
  });

  it('keeps the topic when getMe fails and nothing is cached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await normalizeTopicThreadId('tok-err', 'telegram:5:77')).toBe('telegram:5:77');
  });

  it('caches has_topics_enabled per bot', async () => {
    const fetchMock = stubGetMe({ ok: true, result: { has_topics_enabled: true } });
    await normalizeTopicThreadId('tok-cache', 'telegram:5:1');
    await normalizeTopicThreadId('tok-cache', 'telegram:6:2');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
