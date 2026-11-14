import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DELIVERY_FALLBACK_FROM = 'discord';
  process.env.DELIVERY_FALLBACK_TO = 'telegram:42';
  process.env.DELIVERY_FALLBACK_COOLDOWN_MS = '60000';
});

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

import type { ChannelAdapter } from '../../channels/adapter.js';
import {
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { wrapDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import { pickApprovalDelivery } from '../approvals/primitive.js';
import { createUser } from '../permissions/db/users.js';
// The real modules barrel: deleting the delivery-fallback line there turns this file red.
import '../index.js';

beforeEach(async () => {
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
});

async function mountAdapter(channelType: string, openDM?: (handle: string) => Promise<string>): Promise<void> {
  const adapter: ChannelAdapter = {
    name: channelType,
    channelType,
    instance: channelType,
    supportsThreads: false,
    async setup() {},
    async teardown() {},
    isConnected: () => true,
    async deliver() {
      return undefined;
    },
    async setTyping() {},
    ...(openDM ? { openDM } : {}),
  };
  registerChannelAdapter(channelType, { factory: () => adapter });
  await initChannelAdapters(() => ({
    conversations: [],
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
}

it('the barrel registers the approver order: preferred-channel approvers go last after a failure', async () => {
  await mountAdapter('telegram');
  await mountAdapter('discord', async (handle) => `dm-${handle}`);
  const now = new Date().toISOString();
  await createUser({ id: 'telegram:111', kind: 'telegram', display_name: null, created_at: now });
  await createUser({ id: 'discord:222', kind: 'discord', display_name: null, created_at: now });
  const approvers = ['telegram:111', 'discord:222'];

  expect((await pickApprovalDelivery(approvers, 'discord'))?.userId).toBe('discord:222');

  const failing: ChannelDeliveryAdapter = {
    async deliver() {
      throw new Error('down');
    },
  };
  await wrapDeliveryAdapter(failing)
    .deliver('discord', 'room', null, 'chat', '{}')
    .catch(() => undefined);

  const result = await pickApprovalDelivery(approvers, 'discord');
  expect(result?.userId).toBe('telegram:111');
});

it('the barrel wraps the delivery adapter and retries a failed preferred send on the fallback', async () => {
  const calls: string[] = [];
  const inner: ChannelDeliveryAdapter = {
    async deliver(channelType, platformId) {
      calls.push(`${channelType}:${platformId}`);
      if (channelType === 'discord') throw new Error('discord down');
      return 'ok';
    },
  };
  expect(await wrapDeliveryAdapter(inner).deliver('discord', 'room', null, 'chat', '{}')).toBe('ok');
  expect(calls).toEqual(['discord:room', 'telegram:42']);
});
