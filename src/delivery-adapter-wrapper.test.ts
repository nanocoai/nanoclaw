/**
 * Delivery adapter wrappers.
 *
 * `registerDeliveryAdapterWrapper` lets a module decorate the host's channel
 * delivery adapter; `wrapDeliveryAdapter` is what the entry point applies to
 * the adapter it builds. With nothing registered the adapter passes through
 * untouched.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

import { registerDeliveryAdapterWrapper, wrapDeliveryAdapter, type ChannelDeliveryAdapter } from './delivery.js';

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length) disposers.pop()!();
});

function recordingAdapter(calls: string[]): ChannelDeliveryAdapter {
  return {
    async deliver(channelType, platformId) {
      calls.push(`${channelType}:${platformId}`);
      return 'msg-1';
    },
  };
}

describe('delivery adapter wrappers', () => {
  it('returns the adapter unchanged when no wrapper is registered', () => {
    const adapter = recordingAdapter([]);
    expect(wrapDeliveryAdapter(adapter)).toBe(adapter);
  });

  it('applies a registered wrapper around the adapter', async () => {
    const calls: string[] = [];
    disposers.push(
      registerDeliveryAdapterWrapper((inner) => ({
        deliver: (channelType, platformId, threadId, kind, content, files, instance) =>
          channelType === 'down'
            ? inner.deliver('backup', 'owner-dm', null, kind, content, files)
            : inner.deliver(channelType, platformId, threadId, kind, content, files, instance),
      })),
    );

    const wrapped = wrapDeliveryAdapter(recordingAdapter(calls));
    await wrapped.deliver('down', 'chat-1', null, 'chat', '{}');
    await wrapped.deliver('up', 'chat-2', null, 'chat', '{}');

    expect(calls).toEqual(['backup:owner-dm', 'up:chat-2']);
  });

  it('applies wrappers in registration order, last registered outermost', async () => {
    const order: string[] = [];
    const tag =
      (name: string) =>
      (inner: ChannelDeliveryAdapter): ChannelDeliveryAdapter => ({
        async deliver(...args) {
          order.push(name);
          return inner.deliver(...args);
        },
      });
    disposers.push(registerDeliveryAdapterWrapper(tag('first')));
    disposers.push(registerDeliveryAdapterWrapper(tag('second')));

    await wrapDeliveryAdapter(recordingAdapter([])).deliver('x', 'y', null, 'chat', '{}');

    expect(order).toEqual(['second', 'first']);
  });

  it('stops applying a wrapper once it is unregistered', () => {
    const adapter = recordingAdapter([]);
    const dispose = registerDeliveryAdapterWrapper((inner) => ({ deliver: inner.deliver }));
    dispose();
    expect(wrapDeliveryAdapter(adapter)).toBe(adapter);
  });
});
