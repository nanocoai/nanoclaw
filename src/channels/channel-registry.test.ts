/**
 * Tests for the v2 channel adapter registry and integration with host.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';

import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';

// Mock container runner
vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

// Override DATA_DIR for tests
vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-channels' };
});

const TEST_DIR = '/tmp/nanoclaw-test-channels';

function now() {
  return new Date().toISOString();
}

/** Create a mock ChannelAdapter for testing. */
function createMockAdapter(
  channelType: string,
  instance?: string,
): ChannelAdapter & { delivered: OutboundMessage[]; inbound: InboundMessage[]; setupTimes: number[] } {
  const delivered: OutboundMessage[] = [];
  const inbound: InboundMessage[] = [];
  const setupTimes: number[] = [];
  let setupConfig: ChannelSetup | null = null;

  return {
    name: instance ?? channelType,
    channelType,
    instance,
    supportsThreads: false,
    delivered,
    inbound,
    setupTimes,

    async setup(config: ChannelSetup) {
      setupTimes.push(Date.now());
      setupConfig = config;
    },

    async teardown() {
      setupConfig = null;
    },

    isConnected() {
      return setupConfig !== null;
    },

    async deliver(
      _platformId: string,
      _threadId: string | null,
      message: OutboundMessage,
    ): Promise<string | undefined> {
      delivered.push(message);
      return undefined;
    },

    async setTyping() {},
  };
}

describe('channel registry', () => {
  // Import fresh modules for each test to avoid registry pollution
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('should register and retrieve channel adapters', async () => {
    const { registerChannelAdapter, getRegisteredChannelNames, getChannelContainerConfig } =
      await import('./channel-registry.js');

    registerChannelAdapter('test-channel', {
      factory: () => createMockAdapter('test'),
      containerConfig: {
        env: { TEST_KEY: 'value' },
      },
    });

    expect(getRegisteredChannelNames()).toContain('test-channel');
    expect(getChannelContainerConfig('test-channel')).toEqual({
      env: { TEST_KEY: 'value' },
    });
  });

  it('should skip adapters that return null (missing credentials)', async () => {
    const { registerChannelAdapter, initChannelAdapters, getActiveAdapters } = await import('./channel-registry.js');

    registerChannelAdapter('no-creds', {
      factory: () => null,
    });

    await initChannelAdapters(() => ({
      conversations: [],
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    }));

    // Should not have any active adapters for channels with null factory returns
    const active = getActiveAdapters();
    const noCreds = active.find((a) => a.name === 'no-creds');
    expect(noCreds).toBeUndefined();
  });
});

describe('channel registry — instance keying', () => {
  // Fresh module per test: the registry and activeAdapters maps are
  // module-level, and these arms register conflicting same-channelType
  // adapters that must not leak across tests.
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    const { teardownChannelAdapters } = await import('./channel-registry.js');
    await teardownChannelAdapters();
    // Drop this test's registrations so later describe blocks (which import
    // the registry without resetting) start from an empty registry instead
    // of inheriting same-channelType pairs.
    vi.resetModules();
  });

  const mockSetup = () => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  });

  it('keys two same-channelType adapters by instance — both resolvable', async () => {
    const reg = await import('./channel-registry.js');
    const worker = createMockAdapter('slack', 'slack-worker');
    const tester = createMockAdapter('slack', 'slack-tester');
    reg.registerChannelAdapter('slack-worker', { factory: () => worker });
    reg.registerChannelAdapter('slack-tester', { factory: () => tester });

    await reg.initChannelAdapters(mockSetup);

    expect(reg.getChannelAdapter('slack-worker')).toBe(worker);
    expect(reg.getChannelAdapter('slack-tester')).toBe(tester);
    expect(reg.getActiveAdapters()).toHaveLength(2);
  });

  it('resolves channelType to the default-instance adapter when one exists, else first-registered', async () => {
    const reg = await import('./channel-registry.js');
    const named = createMockAdapter('slack', 'slack-tester');
    const unnamed = createMockAdapter('slack');
    reg.registerChannelAdapter('slack-tester', { factory: () => named });
    reg.registerChannelAdapter('slack', { factory: () => unnamed });

    await reg.initChannelAdapters(mockSetup);

    // Exact key (default instance keyed by channelType) beats the fallback
    // scan, even though the named sibling registered first.
    expect(reg.getChannelAdapter('slack')).toBe(unnamed);

    // With ONLY named instances active, channelType still resolves —
    // deterministic first-registered fallback.
    await reg.teardownChannelAdapters();
    vi.resetModules();
    const reg2 = await import('./channel-registry.js');
    const first = createMockAdapter('slack', 'slack-tester');
    const second = createMockAdapter('slack', 'slack-worker');
    reg2.registerChannelAdapter('slack-tester', { factory: () => first });
    reg2.registerChannelAdapter('slack-worker', { factory: () => second });
    await reg2.initChannelAdapters(mockSetup);
    expect(reg2.getChannelAdapter('slack')).toBe(first);
  });

  it('does NOT reroute default-instance outbound through a named sibling when the default adapter is missing', async () => {
    // The default Slack app is offline (token rotated, factory returned
    // null, …) while a named sibling boots fine. Outbound for the default
    // instance must get the offline-adapter handling (drop into the retry
    // path) — NEVER a cross-identity send through the sibling bot.
    const reg = await import('./channel-registry.js');
    const tester = createMockAdapter('slack', 'slack-tester');
    reg.registerChannelAdapter('slack-tester', { factory: () => tester });
    reg.registerChannelAdapter('slack', { factory: () => null });

    await reg.initChannelAdapters(mockSetup);

    // Exact lookup (delivery/typing path): the default key resolves nothing.
    expect(reg.getChannelAdapterExact('slack')).toBeUndefined();
    // Fallback-capable lookup (channelType-only callers) still resolves.
    expect(reg.getChannelAdapter('slack')).toBe(tester);

    // The delivery bridge dispatches by exact key: a default-instance
    // message (instance === channelType after backfill) is dropped, not
    // delivered through the sibling's identity.
    const bridge = reg.createChannelDeliveryAdapter();
    const result = await bridge.deliver(
      'slack',
      'slack:C1',
      null,
      'chat',
      JSON.stringify({ text: 'to the default bot' }),
      undefined,
      'slack',
    );
    expect(result).toBeUndefined();
    expect(tester.delivered).toHaveLength(0);

    // Sanity: the same bridge DOES deliver when the exact instance is live.
    await bridge.deliver(
      'slack',
      'slack:C1',
      null,
      'chat',
      JSON.stringify({ text: 'to the tester bot' }),
      undefined,
      'slack-tester',
    );
    expect(tester.delivered).toHaveLength(1);
  });
});

describe('channel + router integration', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const { initTestDb, runMigrations, createAgentGroup, createMessagingGroup, createMessagingGroupAgent } =
      await import('../db/index.js');
    const db = initTestDb();
    runMigrations(db);

    createAgentGroup({
      id: 'ag-1',
      name: 'Test Agent',
      folder: 'test-agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'mock',
      platform_id: 'chan-100',
      name: 'Test Channel',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
  });

  afterEach(async () => {
    const { closeDb } = await import('../db/index.js');
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('should route inbound message from adapter to session DB', async () => {
    const { routeInbound } = await import('../router.js');
    const { findSession } = await import('../db/sessions.js');
    const { inboundDbPath } = await import('../session-manager.js');

    // Simulate what the adapter bridge does: stringify content, call routeInbound
    const inboundContent = { sender: 'TestUser', senderId: 'u1', text: 'Hello from adapter', isFromMe: false };

    await routeInbound({
      channelType: 'mock',
      platformId: 'chan-100',
      threadId: null,
      message: {
        id: 'msg-adapter-1',
        kind: 'chat',
        content: JSON.stringify(inboundContent),
        timestamp: now(),
      },
    });

    // Verify session was created and message written
    const session = findSession('mg-1', null);
    expect(session).toBeDefined();

    const dbPath = inboundDbPath('ag-1', session!.id);
    const db = new Database(dbPath);
    const rows = db.prepare('SELECT * FROM messages_in').all() as Array<{ id: string; content: string }>;
    db.close();

    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content).text).toBe('Hello from adapter');
  });

  it('should deliver outbound message through delivery adapter bridge', async () => {
    const { setDeliveryAdapter } = await import('../delivery.js');
    const { getChannelAdapter, registerChannelAdapter, initChannelAdapters } = await import('./channel-registry.js');

    // Register and init a mock adapter
    const mockAdapter = createMockAdapter('mock');
    registerChannelAdapter('mock-delivery', {
      factory: () => mockAdapter,
    });

    await initChannelAdapters(() => ({
      conversations: [],
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    }));

    // Set up delivery adapter bridge (same pattern as index.ts)
    setDeliveryAdapter({
      async deliver(channelType, platformId, threadId, kind, content) {
        const adapter = getChannelAdapter(channelType);
        if (!adapter) return undefined;
        return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content) });
      },
    });

    // Simulate delivery
    const adapter = getChannelAdapter('mock');
    if (adapter) {
      await adapter.deliver('chan-100', null, { kind: 'chat', content: { text: 'Agent response' } });
    }

    expect(mockAdapter.delivered).toHaveLength(1);
    expect((mockAdapter.delivered[0].content as { text: string }).text).toBe('Agent response');
  });
});
