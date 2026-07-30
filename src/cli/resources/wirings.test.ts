/**
 * Wiring creation/update against channel declarations: the resolveDefaults
 * hook fills omitted engage defaults from the adapter declaration ({name}
 * substituted), explicit flags always win, undeclared channels keep the
 * legacy static defaults (back-compat contract), and the create/update
 * validation rejects combinations that could never engage.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// wirings' postCommit projects destinations into live session DBs — no
// sessions run in this test, but the module must not open on-disk DB files.
vi.mock('../../modules/agent-to-agent/write-destinations.js', () => ({
  writeDestinations: vi.fn(),
}));

import type { ChannelDefaults } from '../../channels/adapter.js';
import { registerChannelAdapter } from '../../channels/channel-registry.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from '../../db/index.js';
import { createMessagingGroupAgent, getMessagingGroupAgent } from '../../db/messaging-groups.js';
import { lookup } from '../registry.js';
// Side-effect import: registers wirings-create / wirings-update.
import './wirings.js';

const hostCtx = { caller: 'host' as const };
const now = () => new Date().toISOString();

// Registration-tier declarations only — no adapter is live, which is exactly
// the environment `ncl` sees for offline instances and setup scripts.
const declared: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: 'hey {name}!', threads: false, unknownSenderPolicy: 'public' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};
registerChannelAdapter('declchan', { factory: () => null, defaults: declared });

const neverDeclared: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  group: { engageMode: 'pattern', engagePattern: '{name}', threads: false, unknownSenderPolicy: 'strict' },
  mentions: 'never',
};
registerChannelAdapter('neverchan', { factory: () => null, defaults: neverDeclared });

function mg(id: string, channelType: string, isGroup: number) {
  createMessagingGroup({
    id,
    channel_type: channelType,
    platform_id: `pid-${id}`,
    name: null,
    is_group: isGroup,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
}

async function create(args: Record<string, unknown>) {
  return (await lookup('wirings-create')!.handler(args, hostCtx)) as Record<string, unknown>;
}

async function update(args: Record<string, unknown>) {
  return (await lookup('wirings-update')!.handler(args, hostCtx)) as Record<string, unknown>;
}

beforeEach(() => {
  runMigrations(initTestDb());
  createAgentGroup({
    id: 'ag-1',
    name: 'Helper Bot',
    folder: 'helper-bot',
    agent_provider: null,
    created_at: now(),
  });
  mg('mg-dm', 'declchan', 0);
  mg('mg-group', 'declchan', 1);
  mg('mg-never', 'neverchan', 1);
  mg('mg-stale', 'stalechan', 1); // no declaration anywhere
});

afterEach(() => {
  closeDb();
});

describe('wirings-create — declaration-derived defaults', () => {
  it('fills DM defaults from the declaration with {name} substituted', async () => {
    const row = await create({ messaging_group_id: 'mg-dm', agent_group_id: 'ag-1' });
    expect(row.engage_mode).toBe('pattern');
    expect(row.engage_pattern).toBe('hey Helper Bot!');
  });

  it('fills group defaults from the declaration', async () => {
    const row = await create({ messaging_group_id: 'mg-group', agent_group_id: 'ag-1' });
    expect(row.engage_mode).toBe('mention-sticky');
    const persisted = getMessagingGroupAgent(row.id as string);
    expect(persisted!.engage_pattern).toBeNull();
  });

  it('explicit --engage-mode wins over the declaration', async () => {
    const row = await create({ messaging_group_id: 'mg-group', agent_group_id: 'ag-1', engage_mode: 'mention' });
    expect(row.engage_mode).toBe('mention');
  });

  it('undeclared channels keep the legacy static default (back-compat)', async () => {
    const row = await create({ messaging_group_id: 'mg-stale', agent_group_id: 'ag-1' });
    expect(row.engage_mode).toBe('mention');
    expect(row.engage_pattern).toBeUndefined();
  });
});

describe('wirings-create — validation', () => {
  it('rejects pattern mode without --engage-pattern', async () => {
    await expect(
      create({ messaging_group_id: 'mg-stale', agent_group_id: 'ag-1', engage_mode: 'pattern' }),
    ).rejects.toThrow(/--engage-pattern/);
  });

  it("rejects mention modes on a channel declaring mentions: 'never'", async () => {
    await expect(
      create({ messaging_group_id: 'mg-never', agent_group_id: 'ag-1', engage_mode: 'mention' }),
    ).rejects.toThrow(/mentions: 'never'/);
  });

  it('coerces explicit mention-sticky to mention when the declared context has threads=false', async () => {
    const row = await create({ messaging_group_id: 'mg-dm', agent_group_id: 'ag-1', engage_mode: 'mention-sticky' });
    expect(row.engage_mode).toBe('mention');
  });

  it('coerces mention-sticky when --threads false overrides a threaded declaration', async () => {
    const row = await create({
      messaging_group_id: 'mg-group',
      agent_group_id: 'ag-1',
      engage_mode: 'mention-sticky',
      threads: 'false',
    });
    expect(row.engage_mode).toBe('mention');
    expect(row.threads).toBe(0);
  });

  it('keeps mention-sticky when the declared group context has threads=true', async () => {
    const row = await create({ messaging_group_id: 'mg-group', agent_group_id: 'ag-1', engage_mode: 'mention-sticky' });
    expect(row.engage_mode).toBe('mention-sticky');
  });
});

describe('wirings — threads and priority columns', () => {
  it('omitted --threads stores NULL (inherit declaration)', async () => {
    const row = await create({ messaging_group_id: 'mg-group', agent_group_id: 'ag-1' });
    expect(getMessagingGroupAgent(row.id as string)!.threads).toBeNull();
  });

  it('--threads true/false stores 1/0', async () => {
    const on = await create({ messaging_group_id: 'mg-group', agent_group_id: 'ag-1', threads: 'true' });
    expect(getMessagingGroupAgent(on.id as string)!.threads).toBe(1);
    const off = await create({ messaging_group_id: 'mg-dm', agent_group_id: 'ag-1', threads: 'false' });
    expect(getMessagingGroupAgent(off.id as string)!.threads).toBe(0);
  });

  it('rejects a non-boolean --threads value', async () => {
    await expect(create({ messaging_group_id: 'mg-group', agent_group_id: 'ag-1', threads: 'bogus' })).rejects.toThrow(
      /--threads must be true or false/,
    );
  });

  it('--priority is settable on create and defaults to 0', async () => {
    const dflt = await create({ messaging_group_id: 'mg-dm', agent_group_id: 'ag-1' });
    expect(dflt.priority).toBe(0);
    const high = await create({ messaging_group_id: 'mg-group', agent_group_id: 'ag-1', priority: '5' });
    expect(high.priority).toBe(5);
  });
});

describe('wirings-update — same validation as create', () => {
  it('rejects switching to pattern mode when no engage_pattern exists', async () => {
    const row = await create({ messaging_group_id: 'mg-group', agent_group_id: 'ag-1' }); // sticky, no pattern
    await expect(update({ id: row.id, engage_mode: 'pattern' })).rejects.toThrow(/--engage-pattern/);
  });

  it("rejects switching to a mention mode on a mentions:'never' channel", async () => {
    const row = await create({
      messaging_group_id: 'mg-never',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
    });
    await expect(update({ id: row.id, engage_mode: 'mention' })).rejects.toThrow(/mentions: 'never'/);
  });

  it('coerces an existing sticky wiring to mention when --threads is turned off', async () => {
    const row = await create({ messaging_group_id: 'mg-group', agent_group_id: 'ag-1' }); // mention-sticky
    const updated = (await update({ id: row.id, threads: 'false' })) as { engage_mode: string; threads: number };
    expect(updated.threads).toBe(0);
    expect(updated.engage_mode).toBe('mention');
  });

  it('updates threads and priority', async () => {
    const row = await create({ messaging_group_id: 'mg-dm', agent_group_id: 'ag-1' });
    const updated = (await update({ id: row.id, threads: 'true', priority: '3' })) as {
      threads: number;
      priority: number;
    };
    expect(updated.threads).toBe(1);
    expect(updated.priority).toBe(3);
  });

  it('allows unrelated updates to a legacy pattern row with NULL engage_pattern', async () => {
    // Rows created on main before engage_pattern defaults existed: pattern
    // mode + NULL pattern, which the router evaluates as match-all.
    createMessagingGroupAgent({
      id: 'mga-legacy',
      messaging_group_id: 'mg-stale',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: null,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });

    const updated = (await update({ id: 'mga-legacy', priority: '5' })) as { priority: number };
    expect(updated.priority).toBe(5);
    // The pattern fields stay untouched — no silent backfill.
    expect(getMessagingGroupAgent('mga-legacy')!.engage_pattern).toBeNull();

    // But actually changing the pattern fields to an invalid combination
    // still rejects.
    await expect(update({ id: 'mga-legacy', engage_pattern: '' })).rejects.toThrow(/--engage-pattern/);
  });
});
