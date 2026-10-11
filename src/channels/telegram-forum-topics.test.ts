/**
 * Forum topics are threads; a non-forum group's message_thread_id (a
 * reply-chain root) is folded back to the chat. Kill condition: drop the
 * is_forum check in normalizeTopicThreadId and "non-forum" goes red, so every
 * reply chain in an ordinary group would open its own session.
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

  it('leaves DMs and chat-level ids alone without a lookup', async () => {
    const fetchMock = stubGetChat(true);
    expect(await normalizeTopicThreadId('tok', 'telegram:5')).toBe('telegram:5');
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
