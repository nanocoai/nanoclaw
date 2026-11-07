import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

import { wrapDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import {
  createDeliveryFallback,
  registerDeliveryFallback,
  resolveDeliveryFallbackConfig,
} from './delivery-fallback.js';

const config = { from: 'slack', to: { channelType: 'telegram', platformId: '42' }, cooldownMs: 1000 };

function adapter(calls: string[], failing: Set<string>): ChannelDeliveryAdapter {
  return {
    async deliver(channelType, platformId) {
      calls.push(`${channelType}:${platformId}`);
      if (failing.has(channelType)) throw new Error(`${channelType} down`);
      return `${channelType}-id`;
    },
  };
}

describe('resolveDeliveryFallbackConfig', () => {
  it('is null when nothing is configured', () => {
    expect(resolveDeliveryFallbackConfig({})).toBeNull();
  });

  it('parses the preferred channel, fallback destination and cooldown', () => {
    expect(
      resolveDeliveryFallbackConfig({
        DELIVERY_FALLBACK_FROM: 'slack',
        DELIVERY_FALLBACK_TO: 'telegram:42',
        DELIVERY_FALLBACK_COOLDOWN_MS: '5000',
      }),
    ).toEqual({ from: 'slack', to: { channelType: 'telegram', platformId: '42' }, cooldownMs: 5000 });
  });

  it('defaults the cooldown and keeps colons in the platform id', () => {
    const cfg = resolveDeliveryFallbackConfig({
      DELIVERY_FALLBACK_FROM: 'slack',
      DELIVERY_FALLBACK_TO: 'matrix:!room:example.org',
    });
    expect(cfg?.cooldownMs).toBe(60_000);
    expect(cfg?.to).toEqual({ channelType: 'matrix', platformId: '!room:example.org' });
  });

  it.each([
    ['only FROM', { DELIVERY_FALLBACK_FROM: 'slack' }],
    ['only TO', { DELIVERY_FALLBACK_TO: 'telegram:42' }],
    ['TO without an id', { DELIVERY_FALLBACK_FROM: 'slack', DELIVERY_FALLBACK_TO: 'telegram' }],
    ['same channel', { DELIVERY_FALLBACK_FROM: 'slack', DELIVERY_FALLBACK_TO: 'slack:42' }],
  ])('ignores a bad config: %s', (_name, env) => {
    expect(resolveDeliveryFallbackConfig(env)).toBeNull();
  });
});

describe('createDeliveryFallback wrapper', () => {
  it('passes sends on other channels straight through', async () => {
    const calls: string[] = [];
    const wrapped = createDeliveryFallback(config).wrap(adapter(calls, new Set(['discord'])));
    await expect(wrapped.deliver('discord', 'x', null, 'chat', '{}')).rejects.toThrow('discord down');
    expect(calls).toEqual(['discord:x']);
  });

  it('delivers on the preferred channel when it works', async () => {
    const calls: string[] = [];
    const wrapped = createDeliveryFallback(config).wrap(adapter(calls, new Set()));
    expect(await wrapped.deliver('slack', 'C1', 't1', 'chat', '{}')).toBe('slack-id');
    expect(calls).toEqual(['slack:C1']);
  });

  it('retries a failed preferred send once on the fallback destination', async () => {
    const calls: string[] = [];
    const wrapped = createDeliveryFallback(config).wrap(adapter(calls, new Set(['slack'])));
    expect(await wrapped.deliver('slack', 'C1', 't1', 'chat', '{}')).toBe('telegram-id');
    expect(calls).toEqual(['slack:C1', 'telegram:42']);
  });

  it('rethrows the preferred error when the fallback fails too', async () => {
    const calls: string[] = [];
    const wrapped = createDeliveryFallback(config).wrap(adapter(calls, new Set(['slack', 'telegram'])));
    await expect(wrapped.deliver('slack', 'C1', null, 'chat', '{}')).rejects.toThrow('slack down');
    expect(calls).toEqual(['slack:C1', 'telegram:42']);
  });
});

describe('createDeliveryFallback approver order', () => {
  const approvers = ['slack:U1', 'telegram:7', 'slack:U2'];

  it('keeps the order while the preferred channel is healthy', () => {
    expect(createDeliveryFallback(config).order(approvers)).toEqual(approvers);
  });

  it('moves preferred-channel approvers last after a failure, until the cooldown ends', async () => {
    let t = 0;
    const fallback = createDeliveryFallback(config, () => t);
    const wrapped = fallback.wrap(adapter([], new Set(['slack'])));
    await wrapped.deliver('slack', 'C1', null, 'chat', '{}');

    expect(fallback.order(approvers)).toEqual(['telegram:7', 'slack:U1', 'slack:U2']);
    t = 1000;
    expect(fallback.order(approvers)).toEqual(approvers);
  });

  it('clears the degraded state after a successful preferred send', async () => {
    const failing = new Set(['slack']);
    const fallback = createDeliveryFallback(config, () => 0);
    const wrapped = fallback.wrap(adapter([], failing));
    await wrapped.deliver('slack', 'C1', null, 'chat', '{}');
    failing.clear();
    await wrapped.deliver('slack', 'C1', null, 'chat', '{}');
    expect(fallback.isDegraded()).toBe(false);
  });
});

describe('registerDeliveryFallback', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers nothing without a config, leaving the adapter untouched', () => {
    registerDeliveryFallback(null);
    const inner = adapter([], new Set());
    expect(wrapDeliveryAdapter(inner)).toBe(inner);
  });
});
