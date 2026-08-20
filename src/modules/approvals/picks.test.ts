/**
 * Tests for pickApprover + pickApprovalDelivery — the approver-selection
 * half of what used to live in src/access.ts. Moved here in PR #7 alongside
 * the approvals re-tier.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import type { ChannelAdapter, OutboundMessage } from '../../channels/adapter.js';
import {
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createUser } from '../permissions/db/users.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { pickApprovalDelivery, pickApprover } from './primitive.js';

function now(): string {
  return new Date().toISOString();
}

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
});

async function mountMockAdapter(
  channelType: string,
  openDM?: (handle: string) => Promise<string>,
): Promise<{ delivered: OutboundMessage[]; openDMCalls: string[] }> {
  const delivered: OutboundMessage[] = [];
  const openDMCalls: string[] = [];
  const adapter: ChannelAdapter = {
    name: channelType,
    channelType,
    supportsThreads: false,
    async setup() {},
    async teardown() {},
    isConnected() {
      return true;
    },
    async deliver(_platformId, _threadId, message) {
      delivered.push(message);
      return undefined;
    },
    async setTyping() {},
  };
  if (openDM) {
    adapter.openDM = async (handle: string) => {
      openDMCalls.push(handle);
      return openDM(handle);
    };
  }
  registerChannelAdapter(channelType, { factory: () => adapter });
  await initChannelAdapters(() => ({
    conversations: [],
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
  return { delivered, openDMCalls };
}

async function seedAgentGroup(id: string): Promise<void> {
  await createAgentGroup({
    id,
    name: id.toUpperCase(),
    folder: id,
    agent_provider: null,
    created_at: now(),
  });
}

async function seedUser(id: string, kind: string): Promise<void> {
  await createUser({ id, kind, display_name: null, created_at: now() });
}

describe('pickApprover', () => {
  beforeEach(async () => {
    await seedAgentGroup('ag-1');
    await seedAgentGroup('ag-2');
  });

  it('prefers scoped admins, then globals, then owners — deduplicated', async () => {
    await seedUser('u-owner', 'telegram');
    await seedUser('u-ga', 'telegram');
    await seedUser('u-sa', 'telegram');
    await grantRole({ user_id: 'u-owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
    await grantRole({ user_id: 'u-ga', role: 'admin', agent_group_id: null, granted_by: null, granted_at: now() });
    await grantRole({ user_id: 'u-sa', role: 'admin', agent_group_id: 'ag-1', granted_by: null, granted_at: now() });

    expect(await pickApprover('ag-1')).toEqual(['u-sa', 'u-ga', 'u-owner']);
    expect(await pickApprover('ag-2')).toEqual(['u-ga', 'u-owner']);
    expect(await pickApprover(null)).toEqual(['u-ga', 'u-owner']);
  });

  it('returns empty list when nobody is privileged', async () => {
    expect(await pickApprover('ag-1')).toEqual([]);
  });
});

describe('pickApprovalDelivery', () => {
  beforeEach(async () => {
    await seedAgentGroup('ag-1');
  });

  it('returns the first reachable approver', async () => {
    await mountMockAdapter('telegram');
    await seedUser('telegram:111', 'telegram');
    await seedUser('telegram:222', 'telegram');

    const result = await pickApprovalDelivery(['telegram:111', 'telegram:222'], 'telegram');
    expect(result?.userId).toBe('telegram:111');
    expect(result?.messagingGroup.platform_id).toBe('111');
  });

  it('prefers same-channel-kind approver on tie-break', async () => {
    await mountMockAdapter('telegram');
    await mountMockAdapter('discord', async (h) => `dm-${h}`);
    await seedUser('telegram:111', 'telegram');
    await seedUser('discord:222', 'discord');

    const result = await pickApprovalDelivery(['telegram:111', 'discord:222'], 'discord');
    expect(result?.userId).toBe('discord:222');
  });

  it('falls through to any reachable approver when none match origin', async () => {
    await mountMockAdapter('telegram');
    await seedUser('telegram:111', 'telegram');

    const result = await pickApprovalDelivery(['telegram:111'], 'discord');
    expect(result?.userId).toBe('telegram:111');
  });

  it('returns null when nobody is reachable', async () => {
    await seedUser('telegram:111', 'telegram');
    expect(await pickApprovalDelivery(['telegram:111'], 'telegram')).toBeNull();
  });
});
