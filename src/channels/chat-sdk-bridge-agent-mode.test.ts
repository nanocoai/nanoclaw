/**
 * Agent-mode bridge surfaces:
 *  - app_context: assistant_thread_started / app_context_changed events cache
 *    the latest context per (instance, channel, user); the next inbound DM
 *    message consumes it as content.app_context = { entities }.
 *  - agent-DM opened hook: assistant_thread_started additionally notifies the
 *    registered dm-opened handler, fire-and-forget with error logging.
 *
 * SDK dispatch runs through the REAL Chat instance (the bridge's `_chat` test
 * seam) so the handler registrations in setup() are exercised, not simulated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter, Chat } from 'chat';

import {
  appContextEntities,
  attachAppContext,
  cacheAppContext,
  createChatSdkBridge,
  setAgentDmOpenedHandler,
  takeAppContext,
  type AgentDmOpenedEvent,
} from './chat-sdk-bridge.js';

vi.mock('../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn(),
}));

function stubAdapter(partial: Partial<Adapter> = {}): Adapter {
  return { name: 'slack', initialize: async () => {}, ...partial } as unknown as Adapter;
}

const hostConfig = {
  onInbound: () => {},
  onInboundEvent: () => {},
  onMetadata: () => {},
  onAction: () => {},
};

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const chatOf = (bridge: unknown): Chat => (bridge as any)._chat as Chat;

beforeEach(async () => {
  const { initTestDb } = await import('../db/connection.js');
  const { runMigrations } = await import('../db/migrations/index.js');
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  const { closeDb } = await import('../db/connection.js');
  await closeDb();
  // Module-level singleton: leave no handler behind for the next test file.
  setAgentDmOpenedHandler(() => {});
});

describe('app context cache', () => {
  it('caches per (instance, channel, user) and consumes single-shot', () => {
    cacheAppContext('slack-pixel', 'D0DM1', 'U1', [{ type: 'channel', id: 'C0DESIGN' }]);
    expect(takeAppContext('slack-pixel', 'D0DM1', 'U1')).toEqual([{ type: 'channel', id: 'C0DESIGN' }]);
    // Consumed: the context describes the NEXT message only.
    expect(takeAppContext('slack-pixel', 'D0DM1', 'U1')).toBeUndefined();
  });

  it('matches raw and platform-encoded channel ids (slack:D… vs D…)', () => {
    cacheAppContext('slack-pixel', 'D0DM1', 'U1', [{ type: 'channel', id: 'C9' }]);
    expect(takeAppContext('slack-pixel', 'slack:D0DM1', 'U1')).toEqual([{ type: 'channel', id: 'C9' }]);
  });

  it('is instance- and user-scoped', () => {
    cacheAppContext('slack-pixel', 'D1', 'U1', [{ type: 'channel', id: 'C1' }]);
    expect(takeAppContext('slack-mark', 'D1', 'U1')).toBeUndefined();
    expect(takeAppContext('slack-pixel', 'D1', 'U2')).toBeUndefined();
    expect(takeAppContext('slack-pixel', 'D1', 'U1')).toEqual([{ type: 'channel', id: 'C1' }]);
  });

  it('expires after the TTL (~5min)', () => {
    const t0 = 1_000_000;
    cacheAppContext('slack-pixel', 'D1', 'U1', [{ type: 'channel', id: 'C1' }], t0);
    expect(takeAppContext('slack-pixel', 'D1', 'U1', t0 + 5 * 60 * 1000 + 1)).toBeUndefined();
  });

  it('appContextEntities derives a channel entity from the SDK context shape', () => {
    const event = {
      channelId: 'D1',
      threadId: 'D1:171',
      threadTs: '171',
      userId: 'U1',
      context: { channelId: 'C0DESIGN', teamId: 'T1' },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(appContextEntities(event as any)).toEqual([{ type: 'channel', id: 'C0DESIGN' }]);
  });

  it('appContextEntities prefers a real entities array when a future SDK forwards one', () => {
    const event = {
      channelId: 'D1',
      userId: 'U1',
      context: {
        channelId: 'C0DESIGN',
        entities: [
          { type: 'thread', id: 'C0DESIGN:171' },
          { type: 'canvas', id: 'F0CANVAS' },
          { type: 'bogus' }, // no id — dropped
        ],
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(appContextEntities(event as any)).toEqual([
      { type: 'thread', id: 'C0DESIGN:171' },
      { type: 'canvas', id: 'F0CANVAS' },
    ]);
  });

  it('attachAppContext attaches { entities } once and never overwrites SDK-provided context', () => {
    cacheAppContext('slack-pixel', 'D1', 'U1', [{ type: 'channel', id: 'C1' }]);
    const content: Record<string, unknown> = { text: 'hi' };
    attachAppContext(content, 'slack-pixel', 'slack:D1', 'U1');
    expect(content.app_context).toEqual({ entities: [{ type: 'channel', id: 'C1' }] });

    cacheAppContext('slack-pixel', 'D1', 'U1', [{ type: 'channel', id: 'C2' }]);
    const preAttached: Record<string, unknown> = {
      text: 'hi',
      app_context: { entities: [{ type: 'list', id: 'L1' }] },
    };
    attachAppContext(preAttached, 'slack-pixel', 'slack:D1', 'U1');
    expect(preAttached.app_context).toEqual({ entities: [{ type: 'list', id: 'L1' }] });

    const noUser: Record<string, unknown> = { text: 'hi' };
    attachAppContext(noUser, 'slack-pixel', 'slack:D1', undefined);
    expect(noUser.app_context).toBeUndefined();
  });

  it('assistant events dispatched through the real Chat instance land in the cache', async () => {
    const adapter = stubAdapter();
    const bridge = createChatSdkBridge({ adapter, instance: 'slack-pixel', supportsThreads: true });
    await bridge.setup(hostConfig);

    await dispatch((options) =>
      chatOf(bridge).processAssistantContextChanged(
        {
          adapter,
          channelId: 'D0DM1',
          context: { channelId: 'C0DESIGN' },
          threadId: 'D0DM1:171',
          threadTs: '171',
          userId: 'U1',
        },
        options,
      ),
    );

    expect(takeAppContext('slack-pixel', 'D0DM1', 'U1')).toEqual([{ type: 'channel', id: 'C0DESIGN' }]);
    await bridge.teardown();
  });
});

describe('agent-DM opened hook', () => {
  it('assistant_thread_started notifies the registered handler and caches the context', async () => {
    const events: AgentDmOpenedEvent[] = [];
    setAgentDmOpenedHandler((event) => {
      events.push(event);
    });

    const adapter = stubAdapter();
    const bridge = createChatSdkBridge({ adapter, instance: 'slack-pixel', supportsThreads: true });
    await bridge.setup(hostConfig);

    await dispatch((options) =>
      chatOf(bridge).processAssistantThreadStarted(
        {
          adapter,
          channelId: 'D0DM1',
          context: { channelId: 'C0DESIGN' },
          threadId: 'D0DM1:171',
          threadTs: '171',
          userId: 'U1',
        },
        options,
      ),
    );

    expect(events).toEqual([{ instance: 'slack-pixel', channelId: 'D0DM1' }]);
    expect(takeAppContext('slack-pixel', 'D0DM1', 'U1')).toEqual([{ type: 'channel', id: 'C0DESIGN' }]);
    await bridge.teardown();
  });

  it('a throwing handler is contained (fire-and-forget, dispatch survives)', async () => {
    setAgentDmOpenedHandler(() => {
      throw new Error('boom');
    });
    const adapter = stubAdapter();
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true });
    await bridge.setup(hostConfig);

    await expect(
      dispatch((options) =>
        chatOf(bridge).processAssistantThreadStarted(
          { adapter, channelId: 'D1', context: {}, threadId: 'D1:1', threadTs: '1', userId: 'U1' },
          options,
        ),
      ),
    ).resolves.toBeUndefined();
    await bridge.teardown();
  });
});
