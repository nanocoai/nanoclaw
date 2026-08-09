/**
 * Tests for channel default declarations: getChannelDefaults tiered lookup,
 * the behavior-faithful fallback, and the wiring-creation helpers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { ChannelAdapter, ChannelDefaults, ChannelSetup } from './adapter.js';

function makeDefaults(marker: string, threads = true): ChannelDefaults {
  return {
    dm: { engageMode: 'pattern', engagePattern: marker, threads, unknownSenderPolicy: 'public' },
    group: { engageMode: 'mention', threads, unknownSenderPolicy: 'strict' },
    mentions: 'platform',
  };
}

function makeAdapter(
  channelType: string,
  opts: { instance?: string; supportsThreads?: boolean; defaults?: ChannelDefaults } = {},
): ChannelAdapter {
  return {
    name: opts.instance ?? channelType,
    channelType,
    instance: opts.instance,
    supportsThreads: opts.supportsThreads ?? false,
    defaults: opts.defaults,
    async setup(_config: ChannelSetup) {},
    async teardown() {},
    isConnected: () => true,
    async deliver() {
      return undefined;
    },
  };
}

const mockSetup = () => ({
  onInbound: () => {},
  onInboundEvent: () => {},
  onMetadata: () => {},
  onAction: () => {},
});

describe('getChannelDefaults — tiered lookup', () => {
  // The registry and activeAdapters maps are module-level; fresh module per
  // test so registrations don't leak across arms.
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    const { teardownChannelAdapters } = await import('./channel-registry.js');
    await teardownChannelAdapters();
    vi.resetModules();
  });

  it('live adapter declaration wins over the registration declaration', async () => {
    const reg = await import('./channel-registry.js');
    const liveDecl = makeDefaults('live');
    const regDecl = makeDefaults('registration');
    reg.registerChannelAdapter('mock', {
      factory: () => makeAdapter('mock', { defaults: liveDecl }),
      defaults: regDecl,
    });
    await reg.initChannelAdapters(mockSetup);

    expect(reg.getChannelDefaults('mock')).toBe(liveDecl);
  });

  it('falls through a live channelType scan for a channelType key (live tier instance→channelType)', async () => {
    const reg = await import('./channel-registry.js');
    const decl = makeDefaults('named-instance');
    reg.registerChannelAdapter('slack-tester', {
      factory: () => makeAdapter('slack', { instance: 'slack-tester', defaults: decl }),
    });
    await reg.initChannelAdapters(mockSetup);

    // Key is the bare channelType; only a named instance is live.
    expect(reg.getChannelDefaults('slack')).toBe(decl);
  });

  it('falls through to the registration entry when the factory returned null', async () => {
    const reg = await import('./channel-registry.js');
    const decl = makeDefaults('registration');
    reg.registerChannelAdapter('mock', { factory: () => null, defaults: decl });
    await reg.initChannelAdapters(mockSetup);

    expect(reg.getChannelDefaults('mock')).toBe(decl);
  });

  it('resolves a stale live instance through its channelType registration (registration tier instance→channelType)', async () => {
    const reg = await import('./channel-registry.js');
    const decl = makeDefaults('platform-registration');
    // Stale adapter copy: live under a named-instance key with NO declaration;
    // the platform's registration (keyed by channelType) carries one.
    reg.registerChannelAdapter('slack-tester', {
      factory: () => makeAdapter('slack', { instance: 'slack-tester' }),
    });
    reg.registerChannelAdapter('slack', { factory: () => null, defaults: decl });
    await reg.initChannelAdapters(mockSetup);

    expect(reg.getChannelDefaults('slack-tester')).toBe(decl);
  });

  it('resolves a dead named instance through the channelType hint (registration tier instance→channelType)', async () => {
    const reg = await import('./channel-registry.js');
    const decl = makeDefaults('platform-registration');
    // Nothing live at all: the named instance's factory returned null and its
    // registration has no declaration — only mg.channel_type can bridge.
    reg.registerChannelAdapter('slack-tester', { factory: () => null });
    reg.registerChannelAdapter('slack', { factory: () => null, defaults: decl });
    await reg.initChannelAdapters(mockSetup);

    expect(reg.getChannelDefaults('slack-tester', 'slack')).toBe(decl);
    // Without the hint there is no instance→channelType mapping in the registry.
    expect(reg.getChannelDefaults('slack-tester')).toEqual(reg.fallbackChannelDefaults(false));
  });

  it('uses the live adapter supportsThreads for the fallback tier', async () => {
    const reg = await import('./channel-registry.js');
    reg.registerChannelAdapter('mock', {
      factory: () => makeAdapter('mock', { supportsThreads: true }),
    });
    await reg.initChannelAdapters(mockSetup);

    expect(reg.getChannelDefaults('mock')).toEqual(reg.fallbackChannelDefaults(true));
  });

  it('unknown channel type resolves the conservative fallback', async () => {
    const reg = await import('./channel-registry.js');
    expect(reg.getChannelDefaults('no-such-channel')).toEqual(reg.fallbackChannelDefaults(false));
  });
});

describe('fallbackChannelDefaults — behavior-faithful values', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('reproduces trunk behavior for undeclared adapters', async () => {
    const { fallbackChannelDefaults } = await import('./channel-registry.js');
    expect(fallbackChannelDefaults(true)).toEqual({
      dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'request_approval' },
      group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
      mentions: 'platform',
    });
    // threads track the raw capability in BOTH contexts so NULL-inherit
    // wirings behave exactly like today's supportsThreads-derived routing.
    const nonThreaded = fallbackChannelDefaults(false);
    expect(nonThreaded.dm.threads).toBe(false);
    expect(nonThreaded.group.threads).toBe(false);
    expect(nonThreaded.group.engageMode).toBe('mention-sticky');
  });
});

describe('resolveWiringDefaults', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    const { teardownChannelAdapters } = await import('./channel-registry.js');
    await teardownChannelAdapters();
    vi.resetModules();
  });

  async function withDeclaration(defaults: ChannelDefaults) {
    const reg = await import('./channel-registry.js');
    reg.registerChannelAdapter('mock', { factory: () => null, defaults });
    return import('./channel-defaults.js');
  }

  it('substitutes {name} with the regex-escaped agent group name', async () => {
    const { resolveWiringDefaults } = await withDeclaration({
      dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
      group: { engageMode: 'pattern', engagePattern: '\\b{name}\\b', threads: false, unknownSenderPolicy: 'strict' },
      mentions: 'dm-only',
    });

    expect(resolveWiringDefaults('mock', true, 'C-3PO (dev)')).toEqual({
      engage_mode: 'pattern',
      engage_pattern: '\\bC-3PO \\(dev\\)\\b',
    });
    // DM context: no token, pattern passes through untouched.
    expect(resolveWiringDefaults('mock', false, 'C-3PO (dev)')).toEqual({
      engage_mode: 'pattern',
      engage_pattern: '.',
    });
  });

  it('coerces mention-sticky to mention when the context threads=false', async () => {
    const { resolveWiringDefaults } = await withDeclaration({
      dm: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'strict' },
      group: { engageMode: 'mention-sticky', threads: false, unknownSenderPolicy: 'strict' },
      mentions: 'platform',
    });

    expect(resolveWiringDefaults('mock', true, 'Andy')).toEqual({
      engage_mode: 'mention',
      engage_pattern: null,
    });
  });

  it('keeps mention-sticky when the context threads=true', async () => {
    const { resolveWiringDefaults } = await withDeclaration({
      dm: { engageMode: 'mention', threads: true, unknownSenderPolicy: 'strict' },
      group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'strict' },
      mentions: 'platform',
    });

    expect(resolveWiringDefaults('mock', true, 'Andy')).toEqual({
      engage_mode: 'mention-sticky',
      engage_pattern: null,
    });
  });

  it('throws on a pattern-mode declaration without a pattern', async () => {
    const { resolveWiringDefaults } = await withDeclaration({
      dm: { engageMode: 'pattern', threads: false, unknownSenderPolicy: 'public' },
      group: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'strict' },
      mentions: 'platform',
    });

    expect(() => resolveWiringDefaults('mock', false, 'Andy')).toThrow(/without an engagePattern/);
  });
});

describe('resolveUnknownSenderPolicy', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('selects the context policy from the declaration', async () => {
    const reg = await import('./channel-registry.js');
    reg.registerChannelAdapter('mock', {
      factory: () => null,
      defaults: {
        dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
        group: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'strict' },
        mentions: 'platform',
      },
    });
    const { resolveUnknownSenderPolicy } = await import('./channel-defaults.js');

    expect(resolveUnknownSenderPolicy('mock', false)).toBe('public');
    expect(resolveUnknownSenderPolicy('mock', true)).toBe('strict');
  });
});

describe('resolveThreadPolicy', () => {
  it('ANDs the resolved value with the raw capability', async () => {
    vi.resetModules();
    const { resolveThreadPolicy } = await import('./channel-defaults.js');
    const decl: ChannelDefaults = {
      dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
      group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'strict' },
      mentions: 'platform',
    };

    // NULL = inherit the declaration for the context.
    expect(resolveThreadPolicy(null, decl, true, true)).toBe(true);
    expect(resolveThreadPolicy(null, decl, false, true)).toBe(false);
    // Explicit wiring value beats the declaration…
    expect(resolveThreadPolicy(1, decl, false, true)).toBe(true);
    expect(resolveThreadPolicy(0, decl, true, true)).toBe(false);
    // …but never the capability: no opt-in on a non-threaded platform.
    expect(resolveThreadPolicy(1, decl, true, false)).toBe(false);
    expect(resolveThreadPolicy(null, decl, true, false)).toBe(false);
  });
});
