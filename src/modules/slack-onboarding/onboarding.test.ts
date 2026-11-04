/**
 * DM onboarding welcome prompts — NET-NEW coverage (the release branch had
 * none): the get-started suggested prompts are pinned on the FIRST delivery
 * of an empty-thread DM session (the welcome), (re)asserted or retired when
 * the user opens the agent DM depending on whether a real conversation
 * exists, and retired by the session-created consumer (pinned in
 * thread-title.test.ts).
 *
 * Drives the module through the post-delivery hook (registerPostDeliveryHook)
 * and the bridge's agent-DM-opened handler (setAgentDmOpenedHandler); the
 * hook surfaces are mocked at the import seam. The hook itself guarantees
 * user-facing-rows-only (non-system, non-agent, non-task_log) and the
 * firstDelivery flag — pinned by refa-b2's delivery test, not here.
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

/** Release-branch prompt copy, pinned verbatim (behavior-preservation gate). */
const EXPECTED_PROMPTS = [
  { title: 'Give me the tour', message: 'Give me a quick tour of what you can do.' },
  {
    title: 'What should I try first?',
    message: 'What should I try first? Suggest something useful we could do right now.',
  },
  { title: 'Help me with something', message: 'I have something specific I want help with.' },
];

interface TestMsg {
  id: string;
  kind: string;
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  content: string;
}

function welcomeMsg(overrides: Partial<TestMsg> = {}): TestMsg {
  return {
    id: 'out-1',
    kind: 'chat',
    platformId: 'slack:D1',
    channelType: 'slack',
    threadId: 'slack:D1:',
    content: JSON.stringify({ text: 'Welcome!' }),
    ...overrides,
  };
}

const dmMg = (overrides: Record<string, unknown> = {}) => ({
  id: 'mg-dm',
  channel_type: 'slack',
  platform_id: 'slack:D1',
  instance: 'slack',
  is_group: 0,
  ...overrides,
});

/** The module registers its hooks at import time (module singleton), so it
 *  is loaded once; per-test isolation is mock state — vi.resetAllMocks
 *  restores the original vi.fn implementations between tests. */
type Loaded = Awaited<ReturnType<typeof doLoad>>;
let cached: Loaded | null = null;

async function loadModule(): Promise<Loaded> {
  if (cached) return cached;
  cached = await doLoad();
  return cached;
}

async function doLoad() {
  await import('./index.js');
  const delivery = (await import('../../delivery.js')) as unknown as {
    __postDeliveryHooks: Array<(msg: TestMsg, session: unknown, info: { firstDelivery: boolean }) => void>;
  };
  const bridge = (await import('../../channels/chat-sdk-bridge.js')) as unknown as {
    __dmOpened: { handler: ((e: { instance: string; channelId: string }) => void | Promise<void>) | null };
  };
  const registry = (await import('../../channels/channel-registry.js')) as unknown as {
    setThreadTitle: ReturnType<typeof vi.fn>;
    setSuggestedPrompts: ReturnType<typeof vi.fn>;
  };
  const { getMessagingGroupByPlatform } = (await import('../../db/messaging-groups.js')) as unknown as {
    getMessagingGroupByPlatform: ReturnType<typeof vi.fn>;
  };
  const { getActiveSessions } = (await import('../../db/sessions.js')) as unknown as {
    getActiveSessions: ReturnType<typeof vi.fn>;
  };
  const { log } = (await import('../../log.js')) as unknown as { log: { warn: ReturnType<typeof vi.fn> } };
  expect(delivery.__postDeliveryHooks).toHaveLength(1);
  expect(bridge.__dmOpened.handler).not.toBeNull();
  return {
    postDelivery: delivery.__postDeliveryHooks[0],
    dmOpened: bridge.__dmOpened.handler!,
    registry,
    getMessagingGroupByPlatform,
    getActiveSessions,
    log,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  await loadModule();
});

afterEach(() => {
  vi.resetAllMocks();
});

describe('welcome prompts on first delivery (post-delivery hook)', () => {
  it('pins the get-started prompts on the FIRST delivery of an empty-thread DM', async () => {
    const { postDelivery, registry, getMessagingGroupByPlatform } = await loadModule();
    getMessagingGroupByPlatform.mockReturnValue(dmMg());

    postDelivery(welcomeMsg(), { id: 'sess-1' }, { firstDelivery: true });

    await flush();
    expect(getMessagingGroupByPlatform).toHaveBeenCalledWith('slack', 'slack:D1');
    expect(registry.setSuggestedPrompts.mock.calls).toEqual([['slack', 'slack:D1', EXPECTED_PROMPTS, 'Get started']]);
  });

  it('a threadless welcome row also counts as the welcome', async () => {
    const { postDelivery, registry, getMessagingGroupByPlatform } = await loadModule();
    getMessagingGroupByPlatform.mockReturnValue(dmMg());

    postDelivery(welcomeMsg({ threadId: null }), { id: 'sess-1' }, { firstDelivery: true });

    await flush();
    expect(registry.setSuggestedPrompts).toHaveBeenCalledTimes(1);
  });

  it('never on later deliveries', async () => {
    const { postDelivery, registry, getMessagingGroupByPlatform } = await loadModule();
    getMessagingGroupByPlatform.mockReturnValue(dmMg());

    postDelivery(welcomeMsg(), { id: 'sess-1' }, { firstDelivery: false });

    await flush();
    expect(registry.setSuggestedPrompts).not.toHaveBeenCalled();
  });

  it('never for a threaded delivery (a conversation reply is not the welcome)', async () => {
    const { postDelivery, registry, getMessagingGroupByPlatform } = await loadModule();
    getMessagingGroupByPlatform.mockReturnValue(dmMg());

    postDelivery(welcomeMsg({ threadId: 'slack:D1:171' }), { id: 'sess-1' }, { firstDelivery: true });

    await flush();
    expect(registry.setSuggestedPrompts).not.toHaveBeenCalled();
  });

  it('never for group conversations or unknown messaging groups', async () => {
    const { postDelivery, registry, getMessagingGroupByPlatform } = await loadModule();

    getMessagingGroupByPlatform.mockReturnValue(dmMg({ id: 'mg-room', is_group: 1 }));
    postDelivery(welcomeMsg(), { id: 'sess-1' }, { firstDelivery: true });

    getMessagingGroupByPlatform.mockReturnValue(undefined);
    postDelivery(welcomeMsg(), { id: 'sess-1' }, { firstDelivery: true });

    await flush();
    expect(registry.setSuggestedPrompts).not.toHaveBeenCalled();
  });

  it('no-op when the row has no channel/platform address', async () => {
    const { postDelivery, registry, getMessagingGroupByPlatform } = await loadModule();

    postDelivery(welcomeMsg({ channelType: null }), { id: 'sess-1' }, { firstDelivery: true });
    postDelivery(welcomeMsg({ platformId: null }), { id: 'sess-1' }, { firstDelivery: true });

    await flush();
    expect(getMessagingGroupByPlatform).not.toHaveBeenCalled();
    expect(registry.setSuggestedPrompts).not.toHaveBeenCalled();
  });

  it('keys the prompt set by the mg’s own instance (never a sibling bot)', async () => {
    const { postDelivery, registry, getMessagingGroupByPlatform } = await loadModule();
    getMessagingGroupByPlatform.mockReturnValue(dmMg({ instance: 'slack-teamster' }));

    postDelivery(welcomeMsg(), { id: 'sess-1' }, { firstDelivery: true });

    await flush();
    expect(registry.setSuggestedPrompts).toHaveBeenCalledWith(
      'slack-teamster',
      'slack:D1',
      EXPECTED_PROMPTS,
      'Get started',
    );
  });

  it('prompt failure is decoration: logged, never thrown into delivery', async () => {
    const { postDelivery, registry, getMessagingGroupByPlatform, log } = await loadModule();
    getMessagingGroupByPlatform.mockReturnValue(dmMg());
    registry.setSuggestedPrompts.mockRejectedValueOnce(new Error('not_allowed'));

    expect(() => postDelivery(welcomeMsg(), { id: 'sess-1' }, { firstDelivery: true })).not.toThrow();

    await flush();
    expect(log.warn).toHaveBeenCalledWith(
      'Welcome prompts failed',
      expect.objectContaining({ platformId: 'slack:D1' }),
    );
  });
});

describe('agent-DM opened (bridge handler)', () => {
  it('re-asserts the prompts when the DM is opened before any conversation exists', async () => {
    const { dmOpened, registry, getMessagingGroupByPlatform, getActiveSessions } = await loadModule();
    getMessagingGroupByPlatform.mockReturnValue(dmMg());
    getActiveSessions.mockReturnValue([]);

    await dmOpened({ instance: 'slack', channelId: 'D1' });

    await flush();
    expect(getMessagingGroupByPlatform).toHaveBeenCalledWith('slack', 'slack:D1');
    expect(registry.setSuggestedPrompts.mock.calls).toEqual([['slack', 'slack:D1', EXPECTED_PROMPTS, 'Get started']]);
  });

  it('retires the prompts when a real conversation already exists', async () => {
    const { dmOpened, registry, getMessagingGroupByPlatform, getActiveSessions } = await loadModule();
    getMessagingGroupByPlatform.mockReturnValue(dmMg());
    getActiveSessions.mockReturnValue([{ messaging_group_id: 'mg-dm', thread_id: 'slack:D1:171' }]);

    await dmOpened({ instance: 'slack', channelId: 'D1' });

    await flush();
    expect(registry.setSuggestedPrompts.mock.calls).toEqual([['slack', 'slack:D1', []]]);
  });

  it('sessions without a ts segment do not count as conversations', async () => {
    const { dmOpened, registry, getMessagingGroupByPlatform, getActiveSessions } = await loadModule();
    getMessagingGroupByPlatform.mockReturnValue(dmMg());
    getActiveSessions.mockReturnValue([
      { messaging_group_id: 'mg-dm', thread_id: 'slack:D1:' }, // empty ts → the welcome thread, not a conversation
      { messaging_group_id: 'mg-dm', thread_id: null }, // threadless session
      { messaging_group_id: 'mg-other', thread_id: 'slack:D2:999' }, // someone else's conversation
    ]);

    await dmOpened({ instance: 'slack', channelId: 'D1' });

    await flush();
    expect(registry.setSuggestedPrompts.mock.calls).toEqual([['slack', 'slack:D1', EXPECTED_PROMPTS, 'Get started']]);
  });

  it('no-op for unknown or group messaging groups', async () => {
    const { dmOpened, registry, getMessagingGroupByPlatform } = await loadModule();

    getMessagingGroupByPlatform.mockReturnValue(undefined);
    await dmOpened({ instance: 'slack', channelId: 'D1' });

    getMessagingGroupByPlatform.mockReturnValue(dmMg({ id: 'mg-room', is_group: 1 }));
    await dmOpened({ instance: 'slack', channelId: 'C9' });

    await flush();
    expect(registry.setSuggestedPrompts).not.toHaveBeenCalled();
  });

  it('re-assert keys by the mg’s own instance', async () => {
    const { dmOpened, registry, getMessagingGroupByPlatform, getActiveSessions } = await loadModule();
    getMessagingGroupByPlatform.mockReturnValue(dmMg({ instance: 'slack-teamster' }));
    getActiveSessions.mockReturnValue([]);

    await dmOpened({ instance: 'slack-teamster', channelId: 'D1' });

    await flush();
    expect(registry.setSuggestedPrompts).toHaveBeenCalledWith(
      'slack-teamster',
      'slack:D1',
      EXPECTED_PROMPTS,
      'Get started',
    );
  });
});
