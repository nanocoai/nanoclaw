/**
 * Avatar prefetch (multi-agent creates): prefetchAvatar starts the broker job
 * in the background; the flow's later requestAvatar with the same
 * (displayName, description) consumes that in-flight job instead of starting
 * a second generation. A key miss or an already-consumed entry falls back to
 * a fresh request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearAvatarPrefetches, prefetchAvatar, requestAvatar } from './provision.js';

const fetchMock = vi.fn();

function avatarBrokerResponses(id: string): void {
  fetchMock.mockImplementation((url: string) => {
    if (url.endsWith('/v1/avatars')) {
      return Promise.resolve(new Response(JSON.stringify({ avatar_id: id }), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify({ status: 'ready' }), { status: 200 }));
  });
}

function postCount(): number {
  return fetchMock.mock.calls.filter((c) => (c as [string])[0].endsWith('/v1/avatars')).length;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  clearAvatarPrefetches();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearAvatarPrefetches();
});

describe('avatar prefetch', () => {
  it('requestAvatar consumes a pending prefetch — exactly one generation job', async () => {
    avatarBrokerResponses('av-1');

    prefetchAvatar('https://broker', 'tok', 'Maya', 'content writer');
    const id = await requestAvatar('https://broker', 'tok', 'Maya', 'content writer');

    expect(id).toBe('av-1');
    expect(postCount()).toBe(1);
  });

  it('a prefetch is consumed once — the next same-key request goes fresh', async () => {
    avatarBrokerResponses('av-1');

    prefetchAvatar('https://broker', 'tok', 'Maya', 'content writer');
    await requestAvatar('https://broker', 'tok', 'Maya', 'content writer');
    await requestAvatar('https://broker', 'tok', 'Maya', 'content writer');

    expect(postCount()).toBe(2);
  });

  it('different (name, description) keys never share a job', async () => {
    avatarBrokerResponses('av-x');

    prefetchAvatar('https://broker', 'tok', 'Maya', 'content writer');
    await requestAvatar('https://broker', 'tok', 'Maya', 'designer');

    expect(postCount()).toBe(2);
  });

  it('duplicate prefetches for one key start one job', async () => {
    avatarBrokerResponses('av-1');

    prefetchAvatar('https://broker', 'tok', 'Maya', 'content writer');
    prefetchAvatar('https://broker', 'tok', 'Maya', 'content writer');

    expect(postCount()).toBe(1);
  });

  it('a failed prefetch resolves undefined without throwing into the flow', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));

    prefetchAvatar('https://broker', 'tok', 'Maya', 'content writer');
    const id = await requestAvatar('https://broker', 'tok', 'Maya', 'content writer');

    expect(id).toBeUndefined();
  });
});
