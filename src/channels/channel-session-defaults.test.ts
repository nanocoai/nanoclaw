/**
 * Adapter-declared session-mode wiring defaults, per conversation context.
 *
 * The declaration → resolution → wiring-creation path: a fixture adapter
 * declaring `sessionMode: 'per-thread'` on a context flows through
 * resolveWiringDefaults into the created messaging_group_agents row —
 * session_mode column plus the derived threads=1 stamp (per-thread sessions
 * structurally require honored thread ids, so the stamp is a code invariant
 * of the session mode, not a declared field). The declaration is per-context:
 * dm and group resolve independently, and declaring one leaves the other at
 * today's values. Undeclared adapters resolve to today's behavior exactly —
 * session_mode 'shared', threads column NULL (inherit) — so a trunk update
 * alone changes nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { ChannelAdapter, ChannelContextDefaults, ChannelDefaults, ChannelSetup } from './adapter.js';
import type { AgentGroup, MessagingGroup, MessagingGroupAgent } from '../types.js';

/** A declaration whose `context` roots each conversation in its own thread
 *  (what a platform with thread-rooted conversations would declare): plain
 *  inherit `threads` stays false there (existing NULL wirings keep top-level
 *  replies) while new wirings are stamped per-thread at creation — the
 *  threads=1 stamp is derived from sessionMode by resolveWiringDefaults, not
 *  declared. The other context is left at ordinary values so each arm shows
 *  the declaration is scoped to the context that carries it. */
function perThreadDefaults(
  context: 'dm' | 'group' = 'dm',
  overrides: Partial<ChannelContextDefaults> = {},
): ChannelDefaults {
  const perThread: ChannelContextDefaults = {
    engageMode: context === 'dm' ? 'pattern' : 'mention',
    ...(context === 'dm' ? { engagePattern: '.' } : {}),
    threads: false,
    sessionMode: 'per-thread',
    unknownSenderPolicy: 'request_approval',
    ...overrides,
  };
  const plain: ChannelContextDefaults =
    context === 'dm'
      ? { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' }
      : { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'request_approval' };
  return {
    dm: context === 'dm' ? perThread : plain,
    group: context === 'group' ? perThread : plain,
    mentions: 'platform',
  };
}

function makeAdapter(
  channelType: string,
  opts: { supportsThreads?: boolean; defaults?: ChannelDefaults } = {},
): ChannelAdapter {
  return {
    name: channelType,
    channelType,
    supportsThreads: opts.supportsThreads ?? true,
    defaults: opts.defaults,
    async setup(_config: ChannelSetup) {},
    async teardown() {},
    isConnected: () => true,
    async deliver() {
      return undefined;
    },
  };
}

const mockSetup = () => ({
  onInbound: () => {},
  onInboundEvent: () => {},
  onMetadata: () => {},
  onAction: () => {},
});

/** Register a fixture adapter and return the resolution helpers, all from one
 *  fresh module graph (the registry maps are module-level state). */
async function registerFixture(defaults?: ChannelDefaults) {
  const reg = await import('./channel-registry.js');
  reg.registerChannelAdapter('fixture', { factory: () => makeAdapter('fixture', { defaults }) });
  await reg.initChannelAdapters(mockSetup);
  return import('./channel-defaults.js');
}

// The registry maps and the DB connection handle are module-level; fresh
// module graph per test so registrations and DBs don't leak across arms.
beforeEach(() => {
  vi.resetModules();
});

afterEach(async () => {
  const { teardownChannelAdapters } = await import('./channel-registry.js');
  await teardownChannelAdapters();
  const { closeDb } = await import('../db/index.js');
  try {
    closeDb();
  } catch {
    // Test didn't open a DB.
  }
  vi.resetModules();
});

describe('resolveWiringDefaults — declared session mode and its derived threads stamp', () => {
  it('a per-thread DM declaration resolves into session_mode + the derived threads=1 stamp', async () => {
    const { resolveWiringDefaults } = await registerFixture(perThreadDefaults('dm'));

    expect(resolveWiringDefaults('fixture', false, 'Nano')).toEqual({
      engage_mode: 'pattern',
      engage_pattern: '.',
      session_mode: 'per-thread',
      threads: 1,
    });
  });

  it('a per-thread group declaration resolves the same way — the field is per-context, not DM-only', async () => {
    const { resolveWiringDefaults } = await registerFixture(perThreadDefaults('group'));

    expect(resolveWiringDefaults('fixture', true, 'Nano')).toEqual({
      engage_mode: 'mention',
      engage_pattern: null,
      session_mode: 'per-thread',
      threads: 1,
    });
  });

  it('the context without the declaration is untouched by it', async () => {
    const dmDeclared = await registerFixture(perThreadDefaults('dm'));
    expect(dmDeclared.resolveWiringDefaults('fixture', true, 'Nano')).toMatchObject({
      session_mode: 'shared',
      threads: null,
    });

    vi.resetModules();
    const groupDeclared = await registerFixture(perThreadDefaults('group'));
    expect(groupDeclared.resolveWiringDefaults('fixture', false, 'Nano')).toMatchObject({
      session_mode: 'shared',
      threads: null,
    });
  });

  it('undeclared adapters resolve behavior-faithfully: shared, NULL threads', async () => {
    const { resolveWiringDefaults } = await registerFixture(undefined);

    // Fallback declaration (dm pattern '.'), and no session stamps: shared
    // sessions, threads left NULL to inherit at fanout time.
    expect(resolveWiringDefaults('fixture', false, 'Nano')).toEqual({
      engage_mode: 'pattern',
      engage_pattern: '.',
      session_mode: 'shared',
      threads: null,
    });
  });

  it('the derived threads stamp keeps mention-sticky from downgrading when the inherit value is false', async () => {
    const { resolveWiringDefaults } = await registerFixture(
      perThreadDefaults('dm', { engageMode: 'mention-sticky', engagePattern: undefined }),
    );

    // dm.threads is false, but sessionMode 'per-thread' derives a threads=1
    // stamp for the wiring being created, so sticky engagement (keyed on
    // per-thread session existence) works.
    expect(resolveWiringDefaults('fixture', false, 'Nano')).toEqual({
      engage_mode: 'mention-sticky',
      engage_pattern: null,
      session_mode: 'per-thread',
      threads: 1,
    });
  });

  it('without a per-thread sessionMode, mention-sticky still downgrades on a threads:false context (unchanged behavior)', async () => {
    const { resolveWiringDefaults } = await registerFixture(
      perThreadDefaults('dm', {
        engageMode: 'mention-sticky',
        engagePattern: undefined,
        sessionMode: undefined,
      }),
    );

    expect(resolveWiringDefaults('fixture', false, 'Nano')).toEqual({
      engage_mode: 'mention',
      engage_pattern: null,
      session_mode: 'shared',
      threads: null,
    });
  });
});

describe('wiring creation — resolved defaults persist onto the row', () => {
  /** In-memory central DB + one agent group and messaging group. */
  async function seedDb(channelType: string, isGroup = false) {
    const { initTestDb, runMigrations } = await import('../db/index.js');
    const db = initTestDb();
    runMigrations(db);

    const { createAgentGroup } = await import('../db/agent-groups.js');
    const { createMessagingGroup } = await import('../db/messaging-groups.js');
    const now = new Date().toISOString();
    const ag: AgentGroup = { id: 'ag-1', name: 'Nano', folder: 'nano', agent_provider: null, created_at: now };
    createAgentGroup(ag);
    const mg: MessagingGroup = {
      id: 'mg-1',
      channel_type: channelType,
      platform_id: `${channelType}:@me:owner`,
      name: isGroup ? 'Project channel' : 'Owner DM',
      is_group: isGroup ? 1 : 0,
      unknown_sender_policy: 'strict',
      created_at: now,
    };
    createMessagingGroup(mg);
    return { db, ag, mg, now };
  }

  /** Mirror of init-first-agent's wireIfMissing consumption: resolve the
   *  declaration, stamp engage + session_mode, and persist the explicit
   *  threads value only when the declaration derives one. */
  async function wire(
    mg: MessagingGroup,
    ag: AgentGroup,
    now: string,
    resolved: {
      engage_mode: 'pattern' | 'mention' | 'mention-sticky';
      engage_pattern: string | null;
      session_mode: 'shared' | 'per-thread';
      threads: number | null;
    },
  ): Promise<MessagingGroupAgent> {
    const { createMessagingGroupAgent, getMessagingGroupAgent } = await import('../db/messaging-groups.js');
    createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      engage_mode: resolved.engage_mode,
      engage_pattern: resolved.engage_pattern,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: resolved.session_mode,
      ...(resolved.threads !== null ? { threads: resolved.threads } : {}),
      priority: 0,
      created_at: now,
    });
    return getMessagingGroupAgent('mga-1')!;
  }

  it('declared per-thread DM defaults flow into the created wiring', async () => {
    const { resolveWiringDefaults } = await registerFixture(perThreadDefaults('dm'));
    const { ag, mg, now } = await seedDb('fixture');

    const resolved = resolveWiringDefaults(mg.instance ?? mg.channel_type, mg.is_group === 1, ag.name, mg.channel_type);
    const row = await wire(mg, ag, now, resolved);

    expect(row.session_mode).toBe('per-thread');
    expect(row.threads).toBe(1);
    expect(row.engage_mode).toBe('pattern');
    expect(row.engage_pattern).toBe('.');
  });

  it('declared per-thread group defaults flow into the created wiring the same way', async () => {
    const { resolveWiringDefaults } = await registerFixture(perThreadDefaults('group'));
    const { ag, mg, now } = await seedDb('fixture', true);

    const resolved = resolveWiringDefaults(mg.instance ?? mg.channel_type, mg.is_group === 1, ag.name, mg.channel_type);
    const row = await wire(mg, ag, now, resolved);

    expect(row.session_mode).toBe('per-thread');
    expect(row.threads).toBe(1);
    expect(row.engage_mode).toBe('mention');
  });

  it("undeclared adapter: the created wiring keeps today's shape — shared, threads NULL", async () => {
    const { resolveWiringDefaults } = await registerFixture(undefined);
    const { ag, mg, now } = await seedDb('fixture');

    const resolved = resolveWiringDefaults(mg.instance ?? mg.channel_type, mg.is_group === 1, ag.name, mg.channel_type);
    const row = await wire(mg, ag, now, resolved);

    expect(row.session_mode).toBe('shared');
    expect(row.threads).toBeNull();
  });

  it('updateMessagingGroupAgent accepts a threads override (key widening)', async () => {
    const { resolveWiringDefaults } = await registerFixture(perThreadDefaults('dm'));
    const { ag, mg, now } = await seedDb('fixture');
    const resolved = resolveWiringDefaults(mg.instance ?? mg.channel_type, mg.is_group === 1, ag.name, mg.channel_type);
    await wire(mg, ag, now, resolved);

    const { updateMessagingGroupAgent, getMessagingGroupAgent } = await import('../db/messaging-groups.js');
    updateMessagingGroupAgent('mga-1', { threads: 0 });
    expect(getMessagingGroupAgent('mga-1')!.threads).toBe(0);
  });
});
