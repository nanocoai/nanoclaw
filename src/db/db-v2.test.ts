import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sqliteRaw } from './drivers/sqlite.js';

import {
  initSqliteTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  getAgentGroup,
  getAgentGroupByFolder,
  getAllAgentGroups,
  updateAgentGroup,
  deleteAgentGroup,
  createMessagingGroup,
  getMessagingGroup,
  getMessagingGroupByPlatform,
  updateMessagingGroup,
  deleteMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgents,
  getMessagingGroupAgent,
  updateMessagingGroupAgent,
  deleteMessagingGroupAgent,
  createSession,
  getSession,
  findSession,
  getSessionsByAgentGroup,
  getActiveSessions,
  getRunningSessions,
  updateSession,
  deleteSession,
  createPendingQuestion,
  getPendingQuestion,
  deletePendingQuestion,
  getContainerConfig,
  createContainerConfig,
} from './index.js';

function now() {
  return new Date().toISOString();
}

beforeEach(async () => {
  const db = await initSqliteTestDb();
  await runMigrations(db);
});

afterEach(async () => {
  await closeDb();
});

// ── Migrations ──

describe('migrations', () => {
  it('should be idempotent', async () => {
    const db = await initSqliteTestDb();
    await runMigrations(db);
    // Running again should not throw
    await runMigrations(db);
  });

  it('adds messaging_group_agents.threads as a nullable, default-free override column (019)', async () => {
    const db = await initSqliteTestDb();
    await runMigrations(db);
    const col = sqliteRaw(db)
      .prepare(
        `SELECT type, "notnull", dflt_value FROM pragma_table_info('messaging_group_agents') WHERE name = 'threads'`,
      )
      .get() as { type: string; notnull: number; dflt_value: unknown } | undefined;
    expect(col).toBeDefined();
    // NULL must remain expressible (= inherit the adapter declaration) with
    // no default — a backfill would freeze today's behavior into rows.
    expect(col!.type).toBe('INTEGER');
    expect(col!.notnull).toBe(0);
    expect(col!.dflt_value).toBeNull();
  });

  it('persists approval card bodies for terminal rendering (021)', async () => {
    const db = await initSqliteTestDb();
    await runMigrations(db);
    for (const table of ['pending_approvals', 'pending_channel_approvals', 'pending_sender_approvals']) {
      const col = sqliteRaw(db)
        .prepare(`SELECT type, "notnull", dflt_value FROM pragma_table_info(?) WHERE name = 'question'`)
        .get(table) as { type: string; notnull: number; dflt_value: string } | undefined;
      expect(col, table).toEqual({ type: 'TEXT', notnull: 1, dflt_value: "''" });
    }
  });
});

// ── Agent Groups ──

describe('agent groups', () => {
  const ag = () => ({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });

  it('should create and retrieve', async () => {
    await createAgentGroup(ag());
    const result = await getAgentGroup('ag-1');
    expect(result).toBeDefined();
    expect(result!.name).toBe('Test Agent');
    expect(result!.folder).toBe('test-agent');
  });

  it('should find by folder', async () => {
    await createAgentGroup(ag());
    const result = await getAgentGroupByFolder('test-agent');
    expect(result).toBeDefined();
    expect(result!.id).toBe('ag-1');
  });

  it('should list all', async () => {
    await createAgentGroup(ag());
    await createAgentGroup({ ...ag(), id: 'ag-2', name: 'Another', folder: 'another' });
    expect(await getAllAgentGroups()).toHaveLength(2);
  });

  it('should update', async () => {
    await createAgentGroup(ag());
    await updateAgentGroup('ag-1', { name: 'Updated' });
    expect((await getAgentGroup('ag-1'))!.name).toBe('Updated');
  });

  it('should delete', async () => {
    await createAgentGroup(ag());
    await deleteAgentGroup('ag-1');
    expect(await getAgentGroup('ag-1')).toBeUndefined();
  });

  it('should enforce unique folder', async () => {
    await createAgentGroup(ag());
    await expect(createAgentGroup({ ...ag(), id: 'ag-dup' })).rejects.toThrow();
  });
});

// ── Messaging Groups ──

describe('messaging groups', () => {
  const mg = () => ({
    id: 'mg-1',
    channel_type: 'discord',
    platform_id: 'chan-123',
    name: 'General',
    is_group: 1,
    unknown_sender_policy: 'strict' as const,
    created_at: now(),
  });

  it('should create and retrieve', async () => {
    await createMessagingGroup(mg());
    const result = await getMessagingGroup('mg-1');
    expect(result).toBeDefined();
    expect(result!.channel_type).toBe('discord');
  });

  it('should find by platform', async () => {
    await createMessagingGroup(mg());
    const result = await getMessagingGroupByPlatform('discord', 'chan-123');
    expect(result).toBeDefined();
    expect(result!.id).toBe('mg-1');
  });

  it('should enforce unique channel_type + platform_id', async () => {
    await createMessagingGroup(mg());
    await expect(createMessagingGroup({ ...mg(), id: 'mg-dup' })).rejects.toThrow();
  });

  it('should update', async () => {
    await createMessagingGroup(mg());
    await updateMessagingGroup('mg-1', { name: 'Updated' });
    expect((await getMessagingGroup('mg-1'))!.name).toBe('Updated');
  });

  it('should delete', async () => {
    await createMessagingGroup(mg());
    await deleteMessagingGroup('mg-1');
    expect(await getMessagingGroup('mg-1')).toBeUndefined();
  });
});

// ── Messaging Group Agents ──

describe('messaging group agents', () => {
  beforeEach(async () => {
    await createAgentGroup({
      id: 'ag-1',
      name: 'Agent',
      folder: 'agent',
      agent_provider: null,
      created_at: now(),
    });
    await createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'chan-1',
      name: 'Gen',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
  });

  const mga = () => ({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'pattern' as const,
    engage_pattern: '.',
    sender_scope: 'all' as const,
    ignored_message_policy: 'drop' as const,
    session_mode: 'shared' as const,
    priority: 0,
    created_at: now(),
  });

  it('should create and list by messaging group', async () => {
    await createMessagingGroupAgent(mga());
    const results = await getMessagingGroupAgents('mg-1');
    expect(results).toHaveLength(1);
    expect(results[0].agent_group_id).toBe('ag-1');
  });

  it('should order by priority descending', async () => {
    await createMessagingGroupAgent(mga());
    await createAgentGroup({
      id: 'ag-2',
      name: 'Agent2',
      folder: 'agent2',
      agent_provider: null,
      created_at: now(),
    });
    await createMessagingGroupAgent({ ...mga(), id: 'mga-2', agent_group_id: 'ag-2', priority: 10 });
    const results = await getMessagingGroupAgents('mg-1');
    expect(results[0].agent_group_id).toBe('ag-2');
    expect(results[1].agent_group_id).toBe('ag-1');
  });

  it('should enforce unique messaging_group + agent_group', async () => {
    await createMessagingGroupAgent(mga());
    await expect(createMessagingGroupAgent({ ...mga(), id: 'mga-dup' })).rejects.toThrow();
  });

  it('should update', async () => {
    await createMessagingGroupAgent(mga());
    await updateMessagingGroupAgent('mga-1', { priority: 5 });
    expect((await getMessagingGroupAgent('mga-1'))!.priority).toBe(5);
  });

  it('should delete', async () => {
    await createMessagingGroupAgent(mga());
    await deleteMessagingGroupAgent('mga-1');
    expect(await getMessagingGroupAgents('mg-1')).toHaveLength(0);
  });

  it('should enforce foreign key on agent_group_id', async () => {
    await expect(createMessagingGroupAgent({ ...mga(), agent_group_id: 'nonexistent' })).rejects.toThrow();
  });

  it('auto-creates an agent_destinations row for the wiring', async () => {
    const { getDestinationByTarget, getDestinations } =
      await import('../modules/agent-to-agent/db/agent-destinations.js');
    await createMessagingGroupAgent(mga());

    const dest = await getDestinationByTarget('ag-1', 'channel', 'mg-1');
    expect(dest).toBeDefined();
    expect(dest!.local_name).toBe('gen'); // normalized from mg.name='Gen'
    expect(await getDestinations('ag-1')).toHaveLength(1);
  });

  it('does not duplicate destination row on re-wiring', async () => {
    const { getDestinations } = await import('../modules/agent-to-agent/db/agent-destinations.js');
    await createMessagingGroupAgent(mga());
    // Re-create the same wiring throws (PK unique), but even if we got the
    // row in some other way (e.g. via createDestination directly followed
    // by createMessagingGroupAgent), we should not end up with two rows.
    await deleteMessagingGroupAgent('mga-1');
    await createMessagingGroupAgent(mga());
    expect(await getDestinations('ag-1')).toHaveLength(1);
  });

  it('breaks local_name collisions within an agent group', async () => {
    const { getDestinations } = await import('../modules/agent-to-agent/db/agent-destinations.js');
    // Two messaging groups with the same `name` wired to the same agent
    // should get distinct local_names (gen, gen-2).
    await createMessagingGroupAgent(mga());
    await createMessagingGroup({
      id: 'mg-2',
      channel_type: 'discord',
      platform_id: 'chan-2',
      name: 'Gen',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    await createMessagingGroupAgent({ ...mga(), id: 'mga-2', messaging_group_id: 'mg-2' });

    const dests = (await getDestinations('ag-1')).map((d) => d.local_name).sort();
    expect(dests).toEqual(['gen', 'gen-2']);
  });
});

// ── Sessions ──

describe('sessions', () => {
  beforeEach(async () => {
    await createAgentGroup({
      id: 'ag-1',
      name: 'Agent',
      folder: 'agent',
      agent_provider: null,
      created_at: now(),
    });
    await createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'chan-1',
      name: 'Gen',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
  });

  const sess = () => ({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-1',
    thread_id: null,
    agent_provider: null,
    status: 'active' as const,
    container_status: 'stopped' as const,
    last_active: null,
    created_at: now(),
  });

  it('should create and retrieve', async () => {
    await createSession(sess());
    const result = await getSession('sess-1');
    expect(result).toBeDefined();
    expect(result!.agent_group_id).toBe('ag-1');
  });

  it('should find by messaging group (shared, no thread)', async () => {
    await createSession(sess());
    const result = await findSession('mg-1', null);
    expect(result).toBeDefined();
    expect(result!.id).toBe('sess-1');
  });

  it('should find by messaging group + thread', async () => {
    await createSession({ ...sess(), thread_id: 'thread-1' });
    expect(await findSession('mg-1', 'thread-1')).toBeDefined();
    expect(await findSession('mg-1', 'thread-2')).toBeUndefined();
    expect(await findSession('mg-1', null)).toBeUndefined();
  });

  it('should only find active sessions', async () => {
    await createSession({ ...sess(), status: 'closed' });
    expect(await findSession('mg-1', null)).toBeUndefined();
  });

  it('should list by agent group', async () => {
    await createSession(sess());
    await createSession({ ...sess(), id: 'sess-2', thread_id: 'thread-1' });
    expect(await getSessionsByAgentGroup('ag-1')).toHaveLength(2);
  });

  it('should list active sessions', async () => {
    await createSession(sess());
    await createSession({ ...sess(), id: 'sess-closed', status: 'closed', thread_id: 'thread-x' });
    expect(await getActiveSessions()).toHaveLength(1);
  });

  it('should list running sessions', async () => {
    await createSession({ ...sess(), container_status: 'running' });
    await createSession({ ...sess(), id: 'sess-idle', container_status: 'idle', thread_id: 'thread-1' });
    await createSession({ ...sess(), id: 'sess-stopped', container_status: 'stopped', thread_id: 'thread-2' });
    expect(await getRunningSessions()).toHaveLength(2);
  });

  it('should update', async () => {
    await createSession(sess());
    await updateSession('sess-1', { container_status: 'running', last_active: now() });
    const result = (await getSession('sess-1'))!;
    expect(result.container_status).toBe('running');
    expect(result.last_active).not.toBeNull();
  });

  it('should delete', async () => {
    await createSession(sess());
    await deleteSession('sess-1');
    expect(await getSession('sess-1')).toBeUndefined();
  });
});

// ── Pending Questions ──

describe('pending questions', () => {
  beforeEach(async () => {
    await createAgentGroup({
      id: 'ag-1',
      name: 'Agent',
      folder: 'agent',
      agent_provider: null,
      created_at: now(),
    });
    await createSession({
      id: 'sess-1',
      agent_group_id: 'ag-1',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });
  });

  it('should create and retrieve', async () => {
    await createPendingQuestion({
      question_id: 'q-1',
      session_id: 'sess-1',
      message_out_id: 'msg-out-1',
      platform_id: 'chan-1',
      channel_type: 'discord',
      thread_id: null,
      title: 'Test',
      options: [{ label: 'Yes', selectedLabel: 'Yes', value: 'yes' }],
      created_at: now(),
    });
    const result = await getPendingQuestion('q-1');
    expect(result).toBeDefined();
    expect(result!.session_id).toBe('sess-1');
    expect(result!.title).toBe('Test');
    expect(result!.options[0].value).toBe('yes');
  });

  it('should delete', async () => {
    await createPendingQuestion({
      question_id: 'q-1',
      session_id: 'sess-1',
      message_out_id: 'msg-out-1',
      platform_id: null,
      channel_type: null,
      thread_id: null,
      title: 'Test',
      options: [{ label: 'Yes', selectedLabel: 'Yes', value: 'yes' }],
      created_at: now(),
    });
    await deletePendingQuestion('q-1');
    expect(await getPendingQuestion('q-1')).toBeUndefined();
  });
});

// ── Container Configs ──

describe('container configs', () => {
  it('createContainerConfig persists cli_scope', async () => {
    await createAgentGroup({ id: 'ag-full', name: 'Full', folder: 'full', agent_provider: null, created_at: now() });
    await createContainerConfig({
      agent_group_id: 'ag-full',
      provider: null,
      model: null,
      effort: null,
      image_tag: null,
      assistant_name: null,
      max_messages_per_prompt: null,
      skills: '["all"]',
      mcp_servers: '{}',
      packages_apt: '[]',
      packages_npm: '[]',
      additional_mounts: '[]',
      cli_scope: 'global',
      timezone: null,
      updated_at: now(),
    });
    const row = await getContainerConfig('ag-full');
    expect(row).toBeDefined();
    expect(row!.cli_scope).toBe('global');
  });
});
