import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_ROOT } = vi.hoisted(() => ({ TEST_ROOT: '/tmp/nanoclaw-test-local-web-conversations' }));

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    DATA_DIR: path.join(TEST_ROOT, 'data'),
    GROUPS_DIR: path.join(TEST_ROOT, 'groups'),
    DEFAULT_AGENT_PROVIDER: 'claude',
  };
});

vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../modules/agent-to-agent/write-destinations.js', () => ({ writeDestinations: vi.fn() }));

import { materializeContainerJson } from '../container-config.js';
import { getAgentGroupByFolder, createAgentGroup } from '../db/agent-groups.js';
import { getContainerConfig, updateContainerConfigScalars } from '../db/container-configs.js';
import { closeDb, getDb, initTestDb } from '../db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupByPlatform,
} from '../db/messaging-groups.js';
import { runMigrations } from '../db/migrations/index.js';
import { initGroupFilesystem } from '../group-init.js';
import '../cli/resources/groups.js';
import '../cli/resources/messaging-groups.js';
import '../cli/resources/wirings.js';
import './local-web.js';
import {
  createLocalWebAgent,
  ensureLocalWebConversations,
  listLocalWebCatalog,
  parseCreateLocalWebAgentRequest,
} from './local-web-conversations.js';

async function createGroup(id: string, name: string, folder: string): Promise<void> {
  const group = { id, name, folder, agent_provider: null, created_at: new Date().toISOString() };
  await createAgentGroup(group);
  await initGroupFilesystem(group);
}

async function wireLegacy(agentGroupId: string): Promise<void> {
  const now = new Date().toISOString();
  await createMessagingGroup({
    id: 'mg-legacy',
    channel_type: 'local-web',
    platform_id: 'local-web:local',
    name: 'Legacy',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now,
  });
  await createMessagingGroupAgent({
    id: 'mga-legacy',
    messaging_group_id: 'mg-legacy',
    agent_group_id: agentGroupId,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now,
  });
}

async function count(sql: string, ...values: unknown[]): Promise<number> {
  const row = await getDb().get<{ count: number }>(sql, ...values);
  return row?.count ?? 0;
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('local web create request parsing', () => {
  it('accepts only the bounded product fields', () => {
    expect(parseCreateLocalWebAgentRequest({ name: ' Researcher ' })).toEqual({
      ok: true,
      value: { name: 'Researcher' },
    });
    expect(
      parseCreateLocalWebAgentRequest({
        name: 'Researcher',
        sourceConversationId: 'mg-legacy',
        provider: 'CLAUDE',
        model: 'sonnet',
        effort: 'HIGH',
      }),
    ).toEqual({
      ok: true,
      value: {
        name: 'Researcher',
        sourceConversationId: 'mg-legacy',
        provider: 'claude',
        model: 'sonnet',
        effort: 'high',
      },
    });
    expect(parseCreateLocalWebAgentRequest({ name: 'Researcher', model: '', effort: '' })).toEqual({
      ok: true,
      value: { name: 'Researcher', model: null, effort: null },
    });
  });

  it.each([
    [{ name: 'Researcher', agent_group_id: 'ag-target' }, 'Unknown field'],
    [{ name: '   ' }, '1 to 64'],
    [{ name: '———' }, 'ASCII letter or digit'],
    [{ name: 'bad\u0000name' }, 'control characters'],
    [{ name: 'Researcher', model: 'bad model' }, 'model must be'],
    [{ name: 'Researcher', effort: 'minimal' }, 'effort must be'],
    [{ name: 'Researcher', sourceConversationId: 42 }, 'sourceConversationId must be a string'],
  ])('rejects invalid input %#', (input, message) => {
    expect(parseCreateLocalWebAgentRequest(input)).toMatchObject({
      ok: false,
      message: expect.stringContaining(message),
    });
  });
});

describe('local web conversation backfill', () => {
  it('creates one stable conversation per group without sessions or duplicates', async () => {
    await createGroup('ag-legacy', 'Legacy', 'legacy');
    await createGroup('ag-beta', 'Beta', 'beta');
    await createGroup('ag-alpha', 'alpha', 'alpha');
    await wireLegacy('ag-legacy');
    await updateContainerConfigScalars('ag-alpha', { model: 'sonnet', effort: 'high' });

    await ensureLocalWebConversations();
    await ensureLocalWebConversations();

    const catalog = await listLocalWebCatalog();
    expect(catalog).toMatchObject({
      installedProviders: expect.arrayContaining(['claude']),
      installationDefault: 'claude',
      isInstallationDefaultInstalled: true,
    });
    expect(catalog.conversations.map((conversation) => conversation.agentName)).toEqual(['alpha', 'Beta', 'Legacy']);
    expect(catalog.conversations.find((conversation) => conversation.agentName === 'alpha')).toMatchObject({
      provider: 'claude',
      model: 'sonnet',
      effort: 'high',
    });
    expect(catalog.conversations.find((conversation) => conversation.agentName === 'Legacy')?.isLegacy).toBe(true);
    expect(await count("SELECT COUNT(*) count FROM messaging_groups WHERE channel_type = 'local-web'")).toBe(3);
    expect(
      await count(
        `SELECT COUNT(*) count
           FROM messaging_group_agents mga
           JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
          WHERE mg.channel_type = 'local-web'`,
      ),
    ).toBe(3);
    expect(await count("SELECT COUNT(*) count FROM agent_destinations WHERE target_type = 'channel'")).toBe(3);
    expect(await count('SELECT COUNT(*) count FROM sessions')).toBe(0);
    expect((await getMessagingGroupByPlatform('local-web', 'local-web:local', 'local-web'))?.id).toBe('mg-legacy');
  });
});

describe('local web agent creation', () => {
  it('inherits selected Claude overrides while leaving provider-default storage unset', async () => {
    await createGroup('ag-legacy', 'Legacy', 'legacy');
    await wireLegacy('ag-legacy');
    await updateContainerConfigScalars('ag-legacy', { model: 'sonnet', effort: 'high' });

    const first = await createLocalWebAgent({ name: 'Writer', sourceConversationId: 'mg-legacy' });
    const second = await createLocalWebAgent({ name: ' writer ', sourceConversationId: 'mg-legacy' });

    expect(first).toMatchObject({ ok: true, created: true, conversation: { agentName: 'Writer', provider: 'claude' } });
    expect(second).toMatchObject({
      ok: true,
      created: false,
      conversation: { conversationId: first.ok ? first.conversation.conversationId : '' },
    });
    const group = await getAgentGroupByFolder('web-writer');
    expect(group).toBeDefined();
    const config = await getContainerConfig(group!.id);
    expect(config).toMatchObject({ provider: null, model: 'sonnet', effort: 'high' });
    expect(await materializeContainerJson(group!.id)).toMatchObject({
      provider: undefined,
      model: 'sonnet',
      effort: 'high',
    });
    expect(await count("SELECT COUNT(*) count FROM agent_groups WHERE folder = 'web-writer'")).toBe(1);
    expect(await count('SELECT COUNT(*) count FROM sessions')).toBe(0);
  });

  it('stores explicit Claude provider, model, and effort before first spawn', async () => {
    const result = await createLocalWebAgent({
      name: 'Claude Analyst',
      provider: 'claude',
      model: 'sonnet',
      effort: 'xhigh',
    });
    expect(result).toMatchObject({ ok: true, created: true, conversation: { provider: 'claude' } });
    const group = await getAgentGroupByFolder('web-claude-analyst');
    const config = group && (await getContainerConfig(group.id));
    expect(config).toMatchObject({ provider: 'claude', model: 'sonnet', effort: 'xhigh' });
    expect(await materializeContainerJson(group!.id)).toMatchObject({
      provider: 'claude',
      model: 'sonnet',
      effort: 'xhigh',
    });
  });

  it('uses provider defaults when inherited model and effort choices are cleared', async () => {
    await createGroup('ag-legacy', 'Legacy', 'legacy');
    await wireLegacy('ag-legacy');
    await updateContainerConfigScalars('ag-legacy', { model: 'sonnet', effort: 'high' });

    const result = await createLocalWebAgent({
      name: 'Default Writer',
      sourceConversationId: 'mg-legacy',
      model: null,
      effort: null,
    });

    expect(result).toMatchObject({
      ok: true,
      created: true,
      conversation: { agentName: 'Default Writer', provider: 'claude' },
    });
    const group = await getAgentGroupByFolder('web-default-writer');
    expect(group).toBeDefined();
    expect(await getContainerConfig(group!.id)).toMatchObject({ provider: null, model: null, effort: null });
    expect(await materializeContainerJson(group!.id)).toMatchObject({
      provider: undefined,
      model: undefined,
      effort: undefined,
    });
  });

  it('rejects an uninstalled provider before writing durable state', async () => {
    expect(await createLocalWebAgent({ name: 'Researcher', provider: 'missing-provider' })).toMatchObject({
      ok: false,
      reason: 'provider_not_installed',
    });
    expect(await getAgentGroupByFolder('web-researcher')).toBeUndefined();
  });

  it('resumes a partial group and conversation without duplicating durable state', async () => {
    await createGroup('ag-partial', 'Researcher', 'web-researcher');
    await createMessagingGroup({
      id: 'mg-partial',
      channel_type: 'local-web',
      platform_id: 'local-web:agent:ag-partial',
      name: 'Researcher',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: new Date().toISOString(),
    });

    const result = await createLocalWebAgent({ name: 'Researcher', provider: 'claude', model: 'sonnet' });
    expect(result).toMatchObject({ ok: true, created: false, conversation: { agentName: 'Researcher' } });
    expect(await count("SELECT COUNT(*) count FROM agent_groups WHERE folder = 'web-researcher'")).toBe(1);
    expect(
      await count("SELECT COUNT(*) count FROM messaging_groups WHERE platform_id = 'local-web:agent:ag-partial'"),
    ).toBe(1);
    expect(await count("SELECT COUNT(*) count FROM messaging_group_agents WHERE agent_group_id = 'ag-partial'")).toBe(
      1,
    );
    expect(await count("SELECT COUNT(*) count FROM agent_destinations WHERE agent_group_id = 'ag-partial'")).toBe(1);
  });

  it('serializes concurrent duplicate normalized names onto one agent', async () => {
    const [first, second] = await Promise.all([
      createLocalWebAgent({ name: 'Sales Writer' }),
      createLocalWebAgent({ name: 'sales---writer' }),
    ]);
    expect(first.ok && second.ok).toBe(true);
    expect(first.ok && second.ok && first.conversation.conversationId).toBe(
      second.ok ? second.conversation.conversationId : '',
    );
    expect(await count("SELECT COUNT(*) count FROM agent_groups WHERE folder = 'web-sales-writer'")).toBe(1);
  });

  it('does not fall back when an explicit source conversation is unknown', async () => {
    expect(await createLocalWebAgent({ name: 'Writer', sourceConversationId: 'missing' })).toMatchObject({
      ok: false,
      reason: 'source_not_found',
    });
    expect(await getAgentGroupByFolder('web-writer')).toBeUndefined();
  });
});
