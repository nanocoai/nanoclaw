/**
 * The bot's own display name reaches the bridge at connect.
 *
 * `bridge.setup()` runs the real Chat SDK initialize on a fake adapter; once
 * it returns, the bridge must carry the name the platform gave for the bot's
 * own user id, and nothing when the adapter cannot say or the lookup fails —
 * the host then keeps the group name, as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter } from 'chat';

vi.mock('../webhook-server.js', () => ({ registerWebhookAdapter: vi.fn() }));

import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import type { ChannelSetup } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';

const setup = {
  onInbound: async () => {},
  onInboundEvent: async () => {},
  onMetadata: () => {},
  onAction: () => {},
} as unknown as ChannelSetup;

function makeAdapter(extra: Record<string, unknown>): Adapter {
  return {
    name: 'stub',
    initialize: async () => {},
    channelIdFromThreadId: (threadId: string) => `stub:${threadId}`,
    ...extra,
  } as unknown as Adapter;
}

describe('bridge.botDisplayName', () => {
  beforeEach(async () => {
    await runMigrations(await initTestDb());
  });
  afterEach(async () => {
    await closeDb();
  });

  it('is the platform profile name of the bot user once setup returns', async () => {
    const adapter = makeAdapter({
      botUserId: 'B1',
      getUser: async (id: string) => ({ userId: id, userName: 'frontdesk', fullName: 'Front Desk', isBot: true }),
    });
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true });
    expect(bridge.botDisplayName).toBeUndefined();
    await bridge.setup(setup);
    expect(bridge.botDisplayName).toBe('Front Desk');
    await bridge.teardown();
  });

  it('stays unset when the adapter cannot say or the lookup fails', async () => {
    const silent = createChatSdkBridge({ adapter: makeAdapter({}), supportsThreads: true });
    await silent.setup(setup);
    expect(silent.botDisplayName).toBeUndefined();
    await silent.teardown();

    const failing = createChatSdkBridge({
      adapter: makeAdapter({
        botUserId: 'B1',
        getUser: async () => {
          throw new Error('missing users:read');
        },
      }),
      supportsThreads: true,
    });
    await failing.setup(setup);
    expect(failing.botDisplayName).toBeUndefined();
    await failing.teardown();
  });
});
