/**
 * Tests for the permissions module — canAccessAgentGroup, role helpers, and
 * ensureUserDm. Moved here from src/access.test.ts in PR #7 alongside the
 * approvals re-tier that deleted src/access.ts.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { normalizeWhatsAppHandle } from '../../platform-id.js';
import type { ChannelAdapter, OutboundMessage } from '../../channels/adapter.js';
import {
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../../db/index.js';
import { canAccessAgentGroup } from './access.js';
import { addMember, isMember } from './db/agent-group-members.js';
import { createUser } from './db/users.js';
import { grantRole, hasAnyOwner, isOwner } from './db/user-roles.js';
import { getUserDm } from './db/user-dms.js';
import { ensureUserDm } from './user-dm.js';

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

describe('canAccessAgentGroup', () => {
  beforeEach(() => {
    seedAgentGroup('ag-1');
    seedAgentGroup('ag-2');
  });

  it('denies unknown users', () => {
    const d = canAccessAgentGroup('ghost', 'ag-1');
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.reason).toBe('unknown_user');
  });

  it('allows owners globally', () => {
    seedUser('u-owner', 'telegram');
    grantRole({ user_id: 'u-owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
    expect(canAccessAgentGroup('u-owner', 'ag-1').allowed).toBe(true);
    expect(canAccessAgentGroup('u-owner', 'ag-2').allowed).toBe(true);
  });

  it('allows global admins', () => {
    seedUser('u-ga', 'telegram');
    grantRole({ user_id: 'u-ga', role: 'admin', agent_group_id: null, granted_by: null, granted_at: now() });
    expect(canAccessAgentGroup('u-ga', 'ag-1').allowed).toBe(true);
    expect(canAccessAgentGroup('u-ga', 'ag-2').allowed).toBe(true);
  });

  it('scopes admins to their agent group', () => {
    seedUser('u-sa', 'telegram');
    grantRole({ user_id: 'u-sa', role: 'admin', agent_group_id: 'ag-1', granted_by: null, granted_at: now() });
    expect(canAccessAgentGroup('u-sa', 'ag-1').allowed).toBe(true);
    const denied = canAccessAgentGroup('u-sa', 'ag-2');
    expect(denied.allowed).toBe(false);
    expect(denied.allowed === false && denied.reason).toBe('not_member');
  });

  it('admin @ group is implicitly a member', () => {
    seedUser('u-sa', 'telegram');
    grantRole({ user_id: 'u-sa', role: 'admin', agent_group_id: 'ag-1', granted_by: null, granted_at: now() });
    expect(isMember('u-sa', 'ag-1')).toBe(true);
  });

  it('allows members of the group', () => {
    seedUser('u-m', 'telegram');
    addMember({ user_id: 'u-m', agent_group_id: 'ag-1', added_by: null, added_at: now() });
    expect(canAccessAgentGroup('u-m', 'ag-1').allowed).toBe(true);
    expect(canAccessAgentGroup('u-m', 'ag-2').allowed).toBe(false);
  });

  it('denies known-but-not-member users', () => {
    seedUser('u-known', 'telegram');
    const d = canAccessAgentGroup('u-known', 'ag-1');
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.reason).toBe('not_member');
  });
});

describe('role helpers', () => {
  it('rejects owner rows with a scope', () => {
    seedUser('u-1', 'telegram');
    expect(() =>
      grantRole({
        user_id: 'u-1',
        role: 'owner',
        agent_group_id: 'ag-1',
        granted_by: null,
        granted_at: now(),
      }),
    ).toThrow();
  });

  it('hasAnyOwner reflects owner grants', () => {
    seedUser('u-1', 'telegram');
    expect(hasAnyOwner()).toBe(false);
    grantRole({ user_id: 'u-1', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
    expect(hasAnyOwner()).toBe(true);
    expect(isOwner('u-1')).toBe(true);
  });
});

describe('ensureUserDm', () => {
  it('adapter without openDM: falls through to using the bare handle as platform_id', async () => {
    await mountMockAdapter('nodm');
    seedUser('nodm:123', 'nodm');

    const mg = await ensureUserDm('nodm:123');
    expect(mg).toBeDefined();
    expect(mg!.channel_type).toBe('nodm');
    expect(mg!.platform_id).toBe('123');
    expect(mg!.is_group).toBe(0);

    const cached = getUserDm('nodm:123', 'nodm');
    expect(cached?.messaging_group_id).toBe(mg!.id);
  });

  it('Telegram via chat-sdk-bridge: adapter.openDM returns prefixed platform_id', async () => {
    const mock = await mountMockAdapter('telegram', async (handle) => `telegram:${handle}`);
    seedUser('telegram:6037840640', 'telegram');

    const mg = await ensureUserDm('telegram:6037840640');
    expect(mg).toBeDefined();
    expect(mg!.platform_id).toBe('telegram:6037840640');
    expect(mock.openDMCalls).toEqual(['6037840640']);

    const mg2 = await ensureUserDm('telegram:6037840640');
    expect(mg2!.id).toBe(mg!.id);
    expect(mock.openDMCalls).toEqual(['6037840640']);
  });

  it('resolution-required channels: calls adapter.openDM, uses its result, caches', async () => {
    const mock = await mountMockAdapter('discord', async (handle) => `dm-channel-${handle}`);
    seedUser('discord:user-1', 'discord');

    const mg = await ensureUserDm('discord:user-1');
    expect(mg).toBeDefined();
    expect(mg!.platform_id).toBe('dm-channel-user-1');
    expect(mock.openDMCalls).toEqual(['user-1']);

    const mg2 = await ensureUserDm('discord:user-1');
    expect(mg2!.id).toBe(mg!.id);
    expect(mock.openDMCalls).toEqual(['user-1']);
  });

  it('returns null when the adapter is not registered', async () => {
    seedUser('missing:42', 'missing');
    expect(await ensureUserDm('missing:42')).toBeNull();
  });

  it('returns null when adapter.openDM throws', async () => {
    await mountMockAdapter('slack', async () => {
      throw new Error('openDM boom');
    });
    seedUser('slack:u1', 'slack');
    expect(await ensureUserDm('slack:u1')).toBeNull();
    expect(getUserDm('slack:u1', 'slack')).toBeUndefined();
  });

  it('reuses an existing messaging_group row if one already matches', async () => {
    await mountMockAdapter('telegram');
    seedUser('telegram:555', 'telegram');
    const existing = {
      id: 'mg-preexisting',
      channel_type: 'telegram',
      platform_id: '555',
      name: 'Pre-existing',
      is_group: 0 as const,
      unknown_sender_policy: 'strict' as const,
      created_at: now(),
    };
    createMessagingGroup(existing);

    const mg = await ensureUserDm('telegram:555');\n    expect(mg?.id).toBe('mg-preexisting');
    expect(getUserDm('telegram:555', 'telegram')?.messaging_group_id).toBe('mg-preexisting');
  });
});

// ── #3069 — WhatsApp handle normalization ─────────────────────────────────────
// Both the Baileys (native) and WhatsApp Business Cloud (Chat SDK bridge) paths
// stamp channelType = 'whatsapp', but emit different sender handles:
//   Baileys : "15551234567@s.whatsapp.net" or "15551234567:12@s.whatsapp.net"
//   Cloud   : "15551234567" (bare wa_id)
// normalizeWhatsAppHandle must map all three to the canonical bare-digit form.
describe('normalizeWhatsAppHandle (#3069)', () => {
  it('strips @s.whatsapp.net suffix from a plain Baileys JID', () => {
    expect(normalizeWhatsAppHandle('whatsapp', '15551234567@s.whatsapp.net')).toBe('15551234567');
  });

  it('strips both :device suffix and @s.whatsapp.net from a multi-device JID', () => {
    expect(normalizeWhatsAppHandle('whatsapp', '15551234567:12@s.whatsapp.net')).toBe('15551234567');
  });

  it('is a no-op when the handle is already the bare wa_id (Cloud path)', () => {
    expect(normalizeWhatsAppHandle('whatsapp', '15551234567')).toBe('15551234567');
  });

  it('does not alter WhatsApp group JIDs (@g.us)', () => {
    // Group JIDs are platform IDs, not sender handles; they should never reach
    // this function, but guard against accidental calls.
    expect(normalizeWhatsAppHandle('whatsapp', '120363012345678901@g.us')).toBe(
      '120363012345678901@g.us',
    );
  });

  it('is a no-op for non-WhatsApp channels', () => {
    expect(normalizeWhatsAppHandle('telegram', '15551234567@s.whatsapp.net')).toBe(
      '15551234567@s.whatsapp.net',
    );
    expect(normalizeWhatsAppHandle('slack', 'U0ABC12345')).toBe('U0ABC12345');
  });

  it('produces the same output for all three Baileys/Cloud handle forms for the same number', () => {
    const plain = normalizeWhatsAppHandle('whatsapp', '15551234567@s.whatsapp.net');
    const device = normalizeWhatsAppHandle('whatsapp', '15551234567:12@s.whatsapp.net');
    const bare = normalizeWhatsAppHandle('whatsapp', '15551234567');
    expect(plain).toBe(bare);
    expect(device).toBe(bare);
  });
});
