/**
 * Command-gate denial notices go through the live ChannelDeliveryAdapter —
 * the host must never write the container-owned outbound.db (single-writer
 * invariant). These tests
 * drive the real `routeInbound` deny branch and assert:
 *   - the notice is delivered to the originating address WITH the exact
 *     adapter instance (named-instance channels must not fall through to a
 *     default sibling bot),
 *   - delivery is fire-and-forget: a slow adapter never blocks the route,
 *   - nothing is written to the session (no writeSessionMessage, no wake),
 *   - failed or missing adapters degrade to a logged warning, never a throw.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./db/messaging-groups.js', () => ({
  getMessagingGroupWithAgentCount: vi.fn(() => null),
  getMessagingGroupAgents: vi.fn(() => []),
  getMessagingGroupByPlatform: vi.fn(() => undefined),
  createMessagingGroup: vi.fn(),
}));

vi.mock('./db/agent-groups.js', () => ({
  getAgentGroup: vi.fn(() => ({ id: 'ag-test', name: 'Test' })),
}));

vi.mock('./db/dropped-messages.js', () => ({
  recordDroppedMessage: vi.fn(),
}));

vi.mock('./db/sessions.js', () => ({
  findSessionForAgent: vi.fn(() => undefined),
  getSession: vi.fn(() => ({ id: 'sess-test', agent_group_id: 'ag-test' })),
}));

vi.mock('./session-manager.js', () => ({
  resolveSession: vi.fn(() => ({
    session: { id: 'sess-test', agent_group_id: 'ag-test', messaging_group_id: 'mg-1', thread_id: null },
    created: false,
  })),
  writeSessionMessage: vi.fn(),
}));

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn(async () => true),
}));

vi.mock('./modules/typing/index.js', () => ({
  startTypingRefresh: vi.fn(),
  stopTypingRefresh: vi.fn(),
}));

vi.mock('./channels/channel-registry.js', () => ({
  getChannelAdapter: vi.fn(() => null),
  getChannelDefaults: vi.fn(() => ({
    dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
    group: { engageMode: 'mention-sticky', threads: false, unknownSenderPolicy: 'request_approval' },
    mentions: 'platform',
  })),
}));

vi.mock('./command-gate.js', () => ({
  gateCommand: vi.fn(() => ({ action: 'deny', command: '/clear' })),
}));

vi.mock('./delivery.js', () => ({
  getDeliveryAdapter: vi.fn(),
}));

import { routeInbound, setChannelRequestGate } from './router.js';
import {
  getMessagingGroupWithAgentCount,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
} from './db/messaging-groups.js';
import { resolveSession, writeSessionMessage } from './session-manager.js';
import { wakeContainer } from './container-runner.js';
import { getDeliveryAdapter } from './delivery.js';
import { log } from './log.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

const wiredAgent = {
  id: 'mga-1',
  messaging_group_id: 'mg-1',
  agent_group_id: 'ag-test',
  engage_mode: 'pattern' as const,
  engage_pattern: '.',
  sender_scope: 'all' as const,
  ignored_message_policy: 'drop' as const,
  session_mode: 'shared' as const,
  priority: 0,
  created_at: '2026-06-05T00:00:00Z',
};

function wiredGroup(instance: string) {
  return {
    id: 'mg-1',
    channel_type: 'slack',
    platform_id: 'slack:C123',
    instance,
    name: null,
    is_group: 0,
    unknown_sender_policy: 'public' as const,
    denied_at: null,
    created_at: '2026-06-05T00:00:00Z',
  };
}

function makeDeniedCommandEvent(instance?: string): Parameters<typeof routeInbound>[0] {
  return {
    channelType: 'slack',
    platformId: 'slack:C123',
    threadId: null,
    ...(instance !== undefined ? { instance } : {}),
    message: {
      id: 'msg-deny',
      kind: 'chat',
      content: JSON.stringify({ text: '/clear' }),
      timestamp: '2026-06-05T08:00:00Z',
      isMention: true,
      isGroup: false,
    },
  };
}

describe('router command-gate denial notice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setChannelRequestGate(null as never);
    vi.mocked(getMessagingGroupAgents).mockReturnValue([wiredAgent]);
  });

  it('delivers via the adapter to the originating address with the exact instance', async () => {
    // Named-instance channel (second Slack app): the registry dispatches by
    // exact instance key, so the denial must carry mg.instance — falling
    // through to the default sibling would reply as the wrong bot identity.
    vi.mocked(getMessagingGroupWithAgentCount).mockReturnValue({ mg: wiredGroup('slack-cit'), agentCount: 1 });
    const deliver = vi.fn(async () => undefined);
    vi.mocked(getDeliveryAdapter).mockReturnValue({ deliver } as never);

    await routeInbound(makeDeniedCommandEvent('slack-cit'));
    await flush();

    expect(deliver).toHaveBeenCalledTimes(1);
    const [channelType, platformId, threadId, kind, content, files, instance] = deliver.mock.calls[0] as unknown as [
      string,
      string,
      string | null,
      string,
      string,
      unknown,
      string | undefined,
    ];
    expect(channelType).toBe('slack');
    expect(platformId).toBe('slack:C123');
    expect(threadId).toBeNull();
    expect(kind).toBe('chat');
    expect(JSON.parse(content).text).toContain('Permission denied: /clear');
    expect(files).toBeUndefined();
    expect(instance).toBe('slack-cit');

    // The gate runs BEFORE session resolution: a denied command creates no
    // session row, initializes no session databases, writes nothing, and
    // wakes nothing.
    expect(resolveSession).not.toHaveBeenCalled();
    expect(writeSessionMessage).not.toHaveBeenCalled();
    expect(wakeContainer).not.toHaveBeenCalled();
  });

  it('replyTo redirect resolves the TARGET address instance, not the origin instance', async () => {
    vi.mocked(getMessagingGroupWithAgentCount).mockReturnValue({ mg: wiredGroup('slack-cit'), agentCount: 1 });
    vi.mocked(getMessagingGroupByPlatform).mockReturnValue({ instance: 'discord-ops' } as never);
    const deliver = vi.fn(async () => undefined);
    vi.mocked(getDeliveryAdapter).mockReturnValue({ deliver } as never);

    const event = makeDeniedCommandEvent('slack-cit');
    (event as { replyTo?: unknown }).replyTo = {
      channelType: 'discord',
      platformId: 'discord:C9',
      threadId: null,
    };
    await routeInbound(event);
    await flush();

    expect(getMessagingGroupByPlatform).toHaveBeenCalledWith('discord', 'discord:C9');
    const args = deliver.mock.calls[0] as unknown as [string, string, string | null, string, string, unknown, string?];
    expect(args[0]).toBe('discord');
    expect(args[1]).toBe('discord:C9');
    expect(args[6]).toBe('discord-ops');
  });

  it('same-address replyTo (thread-only redirect) keeps the ORIGIN instance', async () => {
    vi.mocked(getMessagingGroupWithAgentCount).mockReturnValue({ mg: wiredGroup('slack-cit'), agentCount: 1 });
    // Poisoned lookup: if the code consults by-platform for a same-address
    // redirect, it would get the default sibling's instance — wrong bot.
    vi.mocked(getMessagingGroupByPlatform).mockReturnValue({ instance: 'slack' } as never);
    const deliver = vi.fn(async () => undefined);
    vi.mocked(getDeliveryAdapter).mockReturnValue({ deliver } as never);

    const event = makeDeniedCommandEvent('slack-cit');
    (event as { replyTo?: unknown }).replyTo = {
      channelType: 'slack',
      platformId: 'slack:C123',
      threadId: 'T-99',
    };
    await routeInbound(event);
    await flush();

    expect(getMessagingGroupByPlatform).not.toHaveBeenCalled();
    const args = deliver.mock.calls[0] as unknown as [string, string, string | null, string, string, unknown, string?];
    expect(args[2]).toBe('T-99');
    expect(args[6]).toBe('slack-cit');
  });

  it('does not block the route on a slow adapter (fire-and-forget)', async () => {
    vi.mocked(getMessagingGroupWithAgentCount).mockReturnValue({ mg: wiredGroup('slack'), agentCount: 1 });
    // A deliver() that never settles: routeInbound must still return.
    const deliver = vi.fn(() => new Promise<undefined>(() => {}));
    vi.mocked(getDeliveryAdapter).mockReturnValue({ deliver } as never);

    await expect(routeInbound(makeDeniedCommandEvent())).resolves.toBeUndefined();
    expect(deliver).toHaveBeenCalledTimes(1);
    // The denial audit log is reached even though delivery never settled.
    expect(log.info).toHaveBeenCalledWith(
      'Admin command denied by gate',
      expect.objectContaining({ command: '/clear' }),
    );
  });

  it('a failing adapter is best-effort: warning logged, never thrown', async () => {
    vi.mocked(getMessagingGroupWithAgentCount).mockReturnValue({ mg: wiredGroup('slack'), agentCount: 1 });
    const deliver = vi.fn(async () => {
      throw new Error('socket closed');
    });
    vi.mocked(getDeliveryAdapter).mockReturnValue({ deliver } as never);

    await expect(routeInbound(makeDeniedCommandEvent())).resolves.toBeUndefined();
    await flush();

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      'Denial notice delivery failed',
      expect.objectContaining({ command: '/clear' }),
    );
    expect(writeSessionMessage).not.toHaveBeenCalled();
  });

  it('no adapter yet (host booting) degrades to a logged warning, not a throw', async () => {
    vi.mocked(getMessagingGroupWithAgentCount).mockReturnValue({ mg: wiredGroup('slack'), agentCount: 1 });
    vi.mocked(getDeliveryAdapter).mockReturnValue(null);

    await expect(routeInbound(makeDeniedCommandEvent())).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(
      'Denial notice not deliverable (no adapter or address)',
      expect.objectContaining({ command: '/clear' }),
    );
    expect(writeSessionMessage).not.toHaveBeenCalled();
    expect(wakeContainer).not.toHaveBeenCalled();
  });
});
