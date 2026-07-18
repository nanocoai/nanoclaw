import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Adapter } from 'chat';

import { createChatSdkBridge, enrichAttachments, splitForLimit } from './chat-sdk-bridge.js';

function stubAdapter(partial: Partial<Adapter>): Adapter {
  return { name: 'stub', ...partial } as unknown as Adapter;
}

describe('splitForLimit', () => {
  it('returns a single chunk when text fits', () => {
    expect(splitForLimit('short text', 100)).toEqual(['short text']);
  });

  it('splits on paragraph boundaries when available', () => {
    const text = 'para one line one\npara one line two\n\npara two line one\npara two line two';
    const chunks = splitForLimit(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
  });

  it('falls back to line boundaries when no paragraph fits', () => {
    const text = 'alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot';
    const chunks = splitForLimit(text, 15);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(15);
  });

  it('hard-cuts when no whitespace is available', () => {
    const text = 'a'.repeat(100);
    const chunks = splitForLimit(text, 30);
    expect(chunks.length).toBe(Math.ceil(100 / 30));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30);
    expect(chunks.join('')).toBe(text);
  });
});

describe('createChatSdkBridge', () => {
  // The bridge is now transport-only: forward inbound events, relay outbound
  // ops. All per-wiring engage / accumulate / drop / subscribe decisions live
  // in the router (src/router.ts routeInbound / evaluateEngage) and are
  // exercised by host-core.test.ts end-to-end. These tests only cover the
  // bridge's narrow, platform-adjacent surface.

  it('omits openDM when the underlying Chat SDK adapter has none', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeUndefined();
  });

  it('exposes openDM when the underlying adapter has one, and delegates directly', async () => {
    const openDMCalls: string[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        openDM: async (userId: string) => {
          openDMCalls.push(userId);
          return `thread::${userId}`;
        },
        channelIdFromThreadId: (threadId: string) => `stub:${threadId.replace(/^thread::/, '')}`,
      }),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeDefined();
    const platformId = await bridge.openDM!('user-42');
    // Delegation: adapter.openDM → adapter.channelIdFromThreadId, no chat.openDM in between.
    expect(openDMCalls).toEqual(['user-42']);
    expect(platformId).toBe('stub:user-42');
  });

  it('exposes subscribe (lets the router initiate thread subscription on mention-sticky engage)', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: true,
    });
    expect(typeof bridge.subscribe).toBe('function');
  });
});

describe('enrichAttachments', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses fetchData when the adapter provides it', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const result = await enrichAttachments([
      {
        type: 'image',
        name: 'pic.png',
        mimeType: 'image/png',
        size: 3,
        url: 'https://example.com/pic.png',
        fetchData: async () => Buffer.from([1, 2, 3]),
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].data).toBe(Buffer.from([1, 2, 3]).toString('base64'));
    // fetchData wins → no URL fallback
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls back to fetch(url) when fetchData is missing (Discord case)', async () => {
    const url = 'https://cdn.discord.com/attachments/1/2/v.mp4?ex=a&is=b&hm=c';
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array([9, 8, 7, 6]), { status: 200 }));
    const result = await enrichAttachments([
      { type: 'video', name: 'v.mp4', mimeType: 'video/mp4', size: 4, url },
    ]);
    expect(fetchSpy).toHaveBeenCalledWith(url);
    expect(result[0].data).toBe(Buffer.from([9, 8, 7, 6]).toString('base64'));
  });

  it('skips data (but keeps the entry) when both fetchData and url are missing', async () => {
    const result = await enrichAttachments([
      { type: 'file', name: 'no-source.bin', size: 0 },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].data).toBeUndefined();
    expect(result[0].name).toBe('no-source.bin');
  });

  it('logs and continues when the URL fallback returns a non-2xx', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(null, { status: 404, statusText: 'Not Found' }),
    );
    const result = await enrichAttachments([
      { type: 'image', name: 'gone.png', size: 0, url: 'https://example.com/gone.png' },
    ]);
    expect(result[0].data).toBeUndefined();
    expect(result[0].name).toBe('gone.png');
  });

  it('logs and continues when the URL fallback throws (network error)', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await enrichAttachments([
      { type: 'image', name: 'down.png', size: 0, url: 'https://example.com/down.png' },
    ]);
    expect(result[0].data).toBeUndefined();
  });

  it('logs and continues when fetchData itself throws (does not fall through to URL)', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const result = await enrichAttachments([
      {
        type: 'audio',
        name: 'voice.ogg',
        size: 0,
        url: 'https://example.com/voice.ogg',
        fetchData: async () => {
          throw new Error('auth expired');
        },
      },
    ]);
    expect(result[0].data).toBeUndefined();
    // fetchData was attempted; URL fallback is NOT taken — that branch is
    // only for adapters that omit fetchData entirely. An adapter that has
    // fetchData but throws is signaling "I tried and failed", not "I have
    // no idea how to fetch this."
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
