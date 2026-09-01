/**
 * DM thread auto-title (plan 02, D15) — moved from src/router-thread-title.test.ts
 * with the auto-title body's extraction into this module: when a brand-new
 * per-thread DM session is created, the module fire-and-forgets a thread
 * title — the first user message truncated to 45 chars — through the
 * registry's setThreadTitle passthrough, on the platform's thread-
 * materialization timing (delayed initial fire, one retry).
 *
 * The tests drive the module through the router's session-created hook
 * (registerSessionCreatedHook) instead of router internals; the hook
 * surfaces are mocked at the import seam. What the router itself guarantees
 * — the hook fires once per CREATED session, never on reuse and never for
 * the accumulate branch — is pinned by refa-b3's router-session-created
 * test, not here. Capability gating (adapters without setThreadTitle
 * no-op) lives in the registry passthrough (stan-adapter-capabilities).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../delivery.js', () => {
  const hooks: Array<(msg: unknown, session: unknown, info: { firstDelivery: boolean }) => void> = [];
  return {
    registerPostDeliveryHook: (h: (typeof hooks)[number]) => hooks.push(h),
    __postDeliveryHooks: hooks,
  };
});

vi.mock('../../router.js', () => {
  const hooks: Array<(event: never) => void | Promise<void>> = [];
  return {
    registerSessionCreatedHook: (h: (typeof hooks)[number]) => hooks.push(h),
    __sessionCreatedHooks: hooks,
  };
});

vi.mock('../../channels/chat-sdk-bridge.js', () => {
  const ref: { handler: ((e: { instance: string; channelId: string }) => void | Promise<void>) | null } = {
    handler: null,
  };
  return {
    setAgentDmOpenedHandler: (fn: NonNullable<typeof ref.handler>) => {
      ref.handler = fn;
    },
    __dmOpened: ref,
  };
});

vi.mock('../../channels/channel-registry.js', () => ({
  setThreadTitle: vi.fn(async () => {}),
  setSuggestedPrompts: vi.fn(async () => {}),
}));

vi.mock('../../db/messaging-groups.js', () => ({ getMessagingGroupByPlatform: vi.fn(() => undefined) }));
vi.mock('../../db/sessions.js', () => ({ getActiveSessions: vi.fn(() => []) }));
vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function now() {
  return new Date().toISOString();
}

interface TestEvent {
  session: { id: string };
  mg: { id: string; channel_type: string; platform_id: string; instance?: string; is_group: number };
  platformId: string;
  threadId: string | null;
  sessionMode: 'shared' | 'per-thread' | 'agent-shared';
  message: { id: string; kind: string; content: string; timestamp: string };
}

function dmEvent(text: string, overrides: Partial<TestEvent> = {}): TestEvent {
  return {
    session: { id: 'sess-1' },
    mg: { id: 'mg-dm', channel_type: 'slack', platform_id: 'slack:D1', instance: 'slack', is_group: 0 },
    platformId: 'slack:D1',
    threadId: 'slack:D1:171',
    sessionMode: 'per-thread',
    message: {
      id: 'm1',
      kind: 'chat-sdk',
      content: JSON.stringify({ sender: 'Gavriel', senderId: 'U1', text }),
      timestamp: now(),
    },
    ...overrides,
  };
}

/** The module registers its hooks at import time (module singleton), so it
 *  is loaded once; per-test isolation is mock state (vi.resetAllMocks
 *  restores the original vi.fn implementations) + the delays seam. The
 *  default titleDelays are snapshotted at first load, before any test
 *  touches setTitleDelaysForTest. */
type Loaded = {
  mod: typeof import('./index.js');
  sessionCreated: (event: TestEvent) => void | Promise<void>;
  registry: { setThreadTitle: ReturnType<typeof vi.fn>; setSuggestedPrompts: ReturnType<typeof vi.fn> };
  log: { warn: ReturnType<typeof vi.fn> };
};
let cached: Loaded | null = null;
let defaultDelays: { initialMs: number; retryMs: number } | null = null;

async function loadModule(): Promise<Loaded> {
  if (cached) return cached;
  const mod = await import('./index.js');
  const router = (await import('../../router.js')) as unknown as {
    __sessionCreatedHooks: Array<(event: TestEvent) => void | Promise<void>>;
  };
  const registry = (await import('../../channels/channel-registry.js')) as unknown as {
    setThreadTitle: ReturnType<typeof vi.fn>;
    setSuggestedPrompts: ReturnType<typeof vi.fn>;
  };
  const { log } = (await import('../../log.js')) as unknown as { log: { warn: ReturnType<typeof vi.fn> } };
  expect(router.__sessionCreatedHooks).toHaveLength(1);
  defaultDelays = { ...mod.titleDelays };
  cached = { mod, sessionCreated: router.__sessionCreatedHooks[0], registry, log };
  return cached;
}

/** Title fires on a delayed timer (assistant-thread materialization); the
 *  tests zero the delays and flush the macrotask queue before asserting. */
async function flushTitles(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 15));
}

beforeEach(async () => {
  await loadModule();
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('DM thread auto-title (session-created hook)', () => {
  it('preserves the release timing constants: 3s initial, 7s retry', () => {
    expect(defaultDelays).toEqual({ initialMs: 3000, retryMs: 7000 });
  });

  it('titles a NEW per-thread DM session with the first message, truncated to 45 chars', async () => {
    const { mod, sessionCreated, registry } = await loadModule();
    mod.setTitleDelaysForTest(0, 0);

    const longText = 'Can you help me put together the quarterly report for the design review?';
    sessionCreated(dmEvent(longText));

    await flushTitles();
    expect(registry.setThreadTitle.mock.calls).toEqual([['slack', 'slack:D1', 'slack:D1:171', longText.slice(0, 45)]]);
    expect((registry.setThreadTitle.mock.calls[0][3] as string).length).toBe(45);
  });

  it('titles each created conversation independently (once-per-session is the hook contract)', async () => {
    const { mod, sessionCreated, registry } = await loadModule();
    mod.setTitleDelaysForTest(0, 0);

    sessionCreated(dmEvent('first conversation'));
    sessionCreated(dmEvent('second conversation', { session: { id: 'sess-2' }, threadId: 'slack:D1:999' }));

    await flushTitles();
    expect(registry.setThreadTitle).toHaveBeenCalledTimes(2);
    expect(registry.setThreadTitle).toHaveBeenLastCalledWith(
      'slack',
      'slack:D1',
      'slack:D1:999',
      'second conversation',
    );
  });

  it('never fires for shared-session DM wirings (plain-variant bots keep today’s behavior)', async () => {
    const { mod, sessionCreated, registry } = await loadModule();
    mod.setTitleDelaysForTest(0, 0);

    sessionCreated(dmEvent('hello there', { sessionMode: 'shared', threadId: null }));

    await flushTitles();
    expect(registry.setThreadTitle).not.toHaveBeenCalled();
    // The whole block is gated: prompt retirement never fires either.
    expect(registry.setSuggestedPrompts).not.toHaveBeenCalled();
  });

  it('never fires for group conversations', async () => {
    const { mod, sessionCreated, registry } = await loadModule();
    mod.setTitleDelaysForTest(0, 0);

    sessionCreated(
      dmEvent('hello there', {
        mg: { id: 'mg-room', channel_type: 'slack', platform_id: 'slack:C9', instance: 'slack', is_group: 1 },
        platformId: 'slack:C9',
      }),
    );

    await flushTitles();
    expect(registry.setThreadTitle).not.toHaveBeenCalled();
    expect(registry.setSuggestedPrompts).not.toHaveBeenCalled();
  });

  it('never fires without a resolved thread id', async () => {
    const { mod, sessionCreated, registry } = await loadModule();
    mod.setTitleDelaysForTest(0, 0);

    sessionCreated(dmEvent('hello there', { threadId: null }));

    await flushTitles();
    expect(registry.setThreadTitle).not.toHaveBeenCalled();
  });

  it('dispatches through the mg’s own instance key (never a sibling bot)', async () => {
    const { mod, sessionCreated, registry } = await loadModule();
    mod.setTitleDelaysForTest(0, 0);

    sessionCreated(
      dmEvent('hi', {
        mg: { id: 'mg-dm', channel_type: 'slack', platform_id: 'slack:D1', instance: 'slack-teamster', is_group: 0 },
      }),
    );

    await flushTitles();
    expect(registry.setThreadTitle).toHaveBeenCalledWith('slack-teamster', 'slack:D1', 'slack:D1:171', 'hi');
  });

  it('treats unparseable content as raw text (safeParseContent fallback)', async () => {
    const { mod, sessionCreated, registry } = await loadModule();
    mod.setTitleDelaysForTest(0, 0);

    sessionCreated(
      dmEvent('ignored', { message: { id: 'm1', kind: 'chat', content: 'plain text hello', timestamp: now() } }),
    );

    await flushTitles();
    expect(registry.setThreadTitle).toHaveBeenCalledWith('slack', 'slack:D1', 'slack:D1:171', 'plain text hello');
  });

  it('empty first message: no title, but the get-started prompts still retire', async () => {
    const { mod, sessionCreated, registry } = await loadModule();
    mod.setTitleDelaysForTest(0, 0);

    sessionCreated(dmEvent('   '));

    await flushTitles();
    expect(registry.setThreadTitle).not.toHaveBeenCalled();
    expect(registry.setSuggestedPrompts).toHaveBeenCalledWith('slack', 'slack:D1', []);
  });

  it('retires the get-started prompts on the first created conversation', async () => {
    const { mod, sessionCreated, registry } = await loadModule();
    mod.setTitleDelaysForTest(0, 0);

    sessionCreated(dmEvent('let’s go'));

    await flushTitles();
    expect(registry.setSuggestedPrompts).toHaveBeenCalledWith('slack', 'slack:D1', []);
  });

  it('delays the title past assistant-thread materialization and retries once on failure', async () => {
    vi.useFakeTimers();
    const { mod, sessionCreated, registry } = await loadModule();
    mod.setTitleDelaysForTest(10, 20);
    registry.setThreadTitle.mockRejectedValueOnce(new Error('channel_not_found'));

    sessionCreated(dmEvent('needs a retry'));
    expect(registry.setThreadTitle).not.toHaveBeenCalled(); // nothing before the initial delay

    await vi.advanceTimersByTimeAsync(10);
    expect(registry.setThreadTitle).toHaveBeenCalledTimes(1); // initial fire (fails)

    await vi.advanceTimersByTimeAsync(19);
    expect(registry.setThreadTitle).toHaveBeenCalledTimes(1); // retry waits the full retryMs

    await vi.advanceTimersByTimeAsync(1);
    expect(registry.setThreadTitle).toHaveBeenCalledTimes(2); // single retry succeeds
    expect(registry.setThreadTitle).toHaveBeenLastCalledWith('slack', 'slack:D1', 'slack:D1:171', 'needs a retry');
  });

  it('gives up after one retry and logs a warning', async () => {
    vi.useFakeTimers();
    const { mod, sessionCreated, registry, log } = await loadModule();
    mod.setTitleDelaysForTest(0, 0);
    registry.setThreadTitle.mockRejectedValue(new Error('channel_not_found'));

    sessionCreated(dmEvent('never lands'));

    await vi.advanceTimersByTimeAsync(60_000);
    expect(registry.setThreadTitle).toHaveBeenCalledTimes(2); // initial + one retry, never a third
    expect(log.warn).toHaveBeenCalledWith(
      'setThreadTitle failed',
      expect.objectContaining({ sessionId: 'sess-1', threadId: 'slack:D1:171' }),
    );
  });
});
