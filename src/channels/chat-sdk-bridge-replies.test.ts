import type { Adapter } from 'chat';
import { describe, expect, it, vi } from 'vitest';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import type { OutboundMessage } from './adapter.js';

vi.mock('../webhook-server.js', () => ({ registerWebhookAdapter: vi.fn() }));

describe('native reply delivery', () => {
  function fixture(name = 'telegram', maxTextLength = 4096) {
    const postMessage = vi.fn(async (..._args: unknown[]) => ({ id: 'sent', threadId: 'room', raw: {} }));
    const bridge = createChatSdkBridge({
      adapter: { name, postMessage } as unknown as Adapter,
      maxTextLength,
      supportsThreads: false,
    });
    const deliver = (inReplyTo: string | null, text = 'answer', platformId = 'telegram:-100123') =>
      bridge.deliver(platformId, null, { kind: 'chat', content: { text }, inReplyTo } as OutboundMessage);
    return { postMessage, deliver };
  }

  it('quotes a group trigger with the intact composite id, stripping only the agent namespace', async () => {
    const f = fixture();
    await f.deliver('-100123:456:ag-one');
    expect(f.postMessage.mock.calls[0]).toEqual([
      'telegram:-100123',
      { markdown: 'answer', replyTo: '-100123:456' },
      '-100123:456',
    ]);
  });

  it('also accepts a non-namespaced platform id', async () => {
    const f = fixture();
    await f.deliver('-100123:456');
    expect(f.postMessage.mock.calls[0]?.[2]).toBe('-100123:456');
  });

  it('leaves task/accumulate-only sends without a reply target standalone', async () => {
    const f = fixture();
    await f.deliver(null);
    expect(f.postMessage.mock.calls[0]).toEqual(['telegram:-100123', { markdown: 'answer' }]);
  });

  it('quotes only the first chunk', async () => {
    const f = fixture('telegram', 6);
    await f.deliver('-100123:456:ag-one', 'abcdef'.repeat(3));
    expect(f.postMessage).toHaveBeenCalledTimes(3);
    expect(f.postMessage.mock.calls[0]?.[2]).toBe('-100123:456');
    expect(f.postMessage.mock.calls.slice(1)).toEqual([
      ['telegram:-100123', { markdown: 'abcdef' }],
      ['telegram:-100123', { markdown: 'abcdef' }],
    ]);
  });

  it('uses the same target-presence rule in DMs (not a group-only gate)', async () => {
    const f = fixture();
    await f.deliver('123:456:ag-one', 'answer', 'telegram:123');
    expect(f.postMessage.mock.calls[0]?.[2]).toBe('123:456');
  });

  it('preserves Discord replyTo semantics', async () => {
    const f = fixture('discord');
    await f.deliver('456:ag-one');
    expect(f.postMessage.mock.calls[0]).toEqual(['telegram:-100123', { markdown: 'answer', replyTo: '456' }]);
  });
});
