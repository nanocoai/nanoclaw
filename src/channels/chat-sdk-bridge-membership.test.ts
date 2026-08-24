/**
 * Generic bridge membership hook: platform member-joined events are
 * forwarded to the single handler registered per channel type
 * (setMembershipHandler), fire-and-forget with error logging.
 *
 * SDK dispatch runs through the REAL Chat instance built in setup() — the
 * tests capture it via the mocked registerWebhookAdapter (setup hands the
 * Chat instance to the webhook server for non-gateway adapters) — so the
 * handler registrations in setup() are exercised, not simulated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter, Chat } from 'chat';

import { log } from '../log.js';
import { createChatSdkBridge, setMembershipHandler, type MembershipEvent } from './chat-sdk-bridge.js';

vi.mock('../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn(),
}));

import { registerWebhookAdapter } from '../webhook-server.js';

function stubAdapter(name: string, partial: Partial<Adapter> = {}): Adapter {
  return { name, initialize: async () => {}, ...partial } as unknown as Adapter;
}

const hostConfig = {
  onInbound: () => {},
  onInboundEvent: () => {},
  onMetadata: () => {},
  onAction: () => {},
};

/** The Chat instance setup() registered on the (mocked) webhook server. */
function lastRegisteredChat(): Chat {
  const calls = vi.mocked(registerWebhookAdapter).mock.calls;
  return calls[calls.length - 1][0] as Chat;
}

/** Drive a Chat process* dispatcher and await its internal task. */
async function dispatch(fire: (options: { waitUntil: (p: Promise<unknown>) => void }) => void): Promise<void> {
  let task: Promise<unknown> | undefined;
  fire({
    waitUntil: (p) => {
      task = p;
    },
  });
  await task;
}

beforeEach(async () => {
  const { initTestDb } = await import('../db/connection.js');
  const { runMigrations } = await import('../db/migrations/index.js');
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  const { closeDb } = await import('../db/connection.js');
  await closeDb();
  vi.restoreAllMocks();
});

describe('setMembershipHandler', () => {
  it('forwards member_joined_channel through the registered handler with instance identity', async () => {
    const events: MembershipEvent[] = [];
    setMembershipHandler('alpha', (event) => {
      events.push(event);
    });

    const adapter = stubAdapter('alpha');
    const bridge = createChatSdkBridge({ adapter, instance: 'alpha-two', supportsThreads: true });
    await bridge.setup(hostConfig);

    await dispatch((options) =>
      lastRegisteredChat().processMemberJoinedChannel(
        { adapter, channelId: 'C0ROOM1', userId: 'U0NEW', inviterId: 'U0OWNER' },
        options,
      ),
    );

    expect(events).toEqual([
      {
        instance: 'alpha-two',
        channelType: 'alpha',
        channelId: 'C0ROOM1',
        userId: 'U0NEW',
        inviterId: 'U0OWNER',
      },
    ]);
    await bridge.teardown();
  });

  it('default instances key by the platform name', async () => {
    const events: MembershipEvent[] = [];
    setMembershipHandler('bravo', (event) => {
      events.push(event);
    });

    const adapter = stubAdapter('bravo');
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true });
    await bridge.setup(hostConfig);

    await dispatch((options) =>
      lastRegisteredChat().processMemberJoinedChannel({ adapter, channelId: 'C2', userId: 'U2' }, options),
    );

    expect(events).toEqual([
      { instance: 'bravo', channelType: 'bravo', channelId: 'C2', userId: 'U2', inviterId: undefined },
    ]);
    await bridge.teardown();
  });

  it('dispatch is keyed by channelType — a handler for another channel type never fires', async () => {
    const wrongEvents: MembershipEvent[] = [];
    setMembershipHandler('some-other-platform', (event) => {
      wrongEvents.push(event);
    });

    const adapter = stubAdapter('charlie');
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true });
    await bridge.setup(hostConfig);

    // No handler registered for 'charlie' → dispatch is a silent no-op.
    await expect(
      dispatch((options) =>
        lastRegisteredChat().processMemberJoinedChannel({ adapter, channelId: 'C3', userId: 'U3' }, options),
      ),
    ).resolves.toBeUndefined();
    expect(wrongEvents).toEqual([]);
    await bridge.teardown();
  });

  it('a second registration for the same channel type overwrites with a warning', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const first: MembershipEvent[] = [];
    const second: MembershipEvent[] = [];
    setMembershipHandler('delta', (event) => {
      first.push(event);
    });
    setMembershipHandler('delta', (event) => {
      second.push(event);
    });
    expect(warn).toHaveBeenCalledWith('Membership handler overwritten', { channelType: 'delta' });

    const adapter = stubAdapter('delta');
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true });
    await bridge.setup(hostConfig);

    await dispatch((options) =>
      lastRegisteredChat().processMemberJoinedChannel({ adapter, channelId: 'C4', userId: 'U4' }, options),
    );

    expect(first).toEqual([]);
    expect(second).toHaveLength(1);
    await bridge.teardown();
  });

  it('a throwing handler is contained (fire-and-forget, dispatch survives)', async () => {
    setMembershipHandler('echo', () => {
      throw new Error('boom');
    });
    const adapter = stubAdapter('echo');
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true });
    await bridge.setup(hostConfig);

    await expect(
      dispatch((options) =>
        lastRegisteredChat().processMemberJoinedChannel({ adapter, channelId: 'C5', userId: 'U5' }, options),
      ),
    ).resolves.toBeUndefined();
    await bridge.teardown();
  });

  it('an async-rejecting handler is contained too', async () => {
    setMembershipHandler('foxtrot', async () => {
      throw new Error('async boom');
    });
    const adapter = stubAdapter('foxtrot');
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true });
    await bridge.setup(hostConfig);

    await expect(
      dispatch((options) =>
        lastRegisteredChat().processMemberJoinedChannel({ adapter, channelId: 'C6', userId: 'U6' }, options),
      ),
    ).resolves.toBeUndefined();
    // Let the rejected handler promise settle (its .catch logs the error).
    await new Promise((resolve) => setTimeout(resolve, 0));
    await bridge.teardown();
  });
});
