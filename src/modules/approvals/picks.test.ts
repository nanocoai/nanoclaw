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
import { grantRole, revokeRole } from '../permissions/db/user-roles.js';
import { pickApprovalDelivery, pickApprover, pickPrivilegedApprover } from './primitive.js';

function now(): string {
  return new Date().toISOString();
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(async () => {
  await teardownChannelAdapters();
  closeDb();
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

function seedAgentGroup(id: string): void {
  createAgentGroup({
    id,
    name: id.toUpperCase(),
    folder: id,
    agent_provider: null,
    created_at: now(),
  });
}

function seedUser(id: string, kind: string): void {
  createUser({ id, kind, display_name: null, created_at: now() });
}

/** Drop this user's global owner + global admin rows (test convenience). */
function revokeAll(userId: string): void {
  revokeRole(userId, 'owner', null);
  revokeRole(userId, 'admin', null);
}

describe('pickApprover', () => {
  beforeEach(() => {
    seedAgentGroup('ag-1');
    seedAgentGroup('ag-2');
  });

  it('prefers scoped admins, then globals, then owners — deduplicated', () => {
    seedUser('u-owner', 'telegram');
    seedUser('u-ga', 'telegram');
    seedUser('u-sa', 'telegram');
    grantRole({ user_id: 'u-owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
    grantRole({ user_id: 'u-ga', role: 'admin', agent_group_id: null, granted_by: null, granted_at: now() });
    grantRole({ user_id: 'u-sa', role: 'admin', agent_group_id: 'ag-1', granted_by: null, granted_at: now() });

    expect(pickApprover('ag-1')).toEqual(['u-sa', 'u-ga', 'u-owner']);
    expect(pickApprover('ag-2')).toEqual(['u-ga', 'u-owner']);
    expect(pickApprover(null)).toEqual(['u-ga', 'u-owner']);
  });

  it('returns empty list when nobody is privileged', () => {
    expect(pickApprover('ag-1')).toEqual([]);
  });
});

describe('pickPrivilegedApprover', () => {
  beforeEach(() => {
    seedAgentGroup('ag-1');
    seedUser('u-owner', 'telegram');
    seedUser('u-owner2', 'telegram');
    seedUser('u-ga', 'telegram');
    seedUser('u-sa', 'telegram');
    grantRole({ user_id: 'u-owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
    grantRole({ user_id: 'u-owner2', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
    grantRole({ user_id: 'u-ga', role: 'admin', agent_group_id: null, granted_by: null, granted_at: now() });
    grantRole({ user_id: 'u-sa', role: 'admin', agent_group_id: 'ag-1', granted_by: null, granted_at: now() });
  });

  it('owner level: returns only owners (never a global or scoped admin), highest first', () => {
    expect(pickPrivilegedApprover({ minLevel: 'owner' })).toEqual(['u-owner', 'u-owner2']);
  });

  it('global-admin level: returns owners then global admins, never a scoped admin', () => {
    expect(pickPrivilegedApprover({ minLevel: 'global-admin' })).toEqual(['u-owner', 'u-owner2', 'u-ga']);
  });

  it('excludes the target of the change from the pool (no self-approval)', () => {
    // Revoking u-owner's owner role must not route the card to u-owner.
    expect(pickPrivilegedApprover({ minLevel: 'owner', excludeUserIds: ['u-owner'] })).toEqual(['u-owner2']);
    // A scoped admin can never appear even if named as an exclude no-op.
    expect(pickPrivilegedApprover({ minLevel: 'global-admin', excludeUserIds: ['u-ga'] })).toEqual([
      'u-owner',
      'u-owner2',
    ]);
  });

  it('fails closed (empty) when the only eligible approver is the target', () => {
    // Sole owner revoking their own owner role → nobody left to approve.
    revokeAll('u-owner2');
    expect(pickPrivilegedApprover({ minLevel: 'owner', excludeUserIds: ['u-owner'] })).toEqual([]);
  });

  it('fails closed (empty) when only juniors exist for an owner-level change', () => {
    revokeAll('u-owner');
    revokeAll('u-owner2');
    // Only a global admin + scoped admin remain — neither qualifies for owner level.
    expect(pickPrivilegedApprover({ minLevel: 'owner' })).toEqual([]);
  });
});

describe('pickApprovalDelivery', () => {
  beforeEach(() => {
    seedAgentGroup('ag-1');
  });

  it('returns the first reachable approver', async () => {
    await mountMockAdapter('telegram');
    seedUser('telegram:111', 'telegram');
    seedUser('telegram:222', 'telegram');

    const result = await pickApprovalDelivery(['telegram:111', 'telegram:222'], 'telegram');
    expect(result?.userId).toBe('telegram:111');
    expect(result?.messagingGroup.platform_id).toBe('111');
  });

  it('prefers same-channel-kind approver on tie-break', async () => {
    await mountMockAdapter('telegram');
    await mountMockAdapter('discord', async (h) => `dm-${h}`);
    seedUser('telegram:111', 'telegram');
    seedUser('discord:222', 'discord');

    const result = await pickApprovalDelivery(['telegram:111', 'discord:222'], 'discord');
    expect(result?.userId).toBe('discord:222');
  });

  it('falls through to any reachable approver when none match origin', async () => {
    await mountMockAdapter('telegram');
    seedUser('telegram:111', 'telegram');

    const result = await pickApprovalDelivery(['telegram:111'], 'discord');
    expect(result?.userId).toBe('telegram:111');
  });

  it('returns null when nobody is reachable', async () => {
    seedUser('telegram:111', 'telegram');
    expect(await pickApprovalDelivery(['telegram:111'], 'telegram')).toBeNull();
  });
});
