import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  initTestDb,
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
} from './index.js';

function now() {
  return new Date().toISOString();
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

// ── Migrations ──

describe('migrations', () => {
  it('should be idempotent', () => {
    const db = initTestDb();
    runMigrations(db);
    // Running again should not throw
    runMigrations(db);
  });

  it('adds messaging_group_agents.threads as a nullable, default-free override column (019)', () => {
    const db = initTestDb();
    runMigrations(db);
    const col = db
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

  it('should create and retrieve', () => {
    createAgentGroup(ag());
    const result = getAgentGroup('ag-1');
    expect(result).toBeDefined();
    expect(result!.name).toBe('Test Agent');
    expect(result!.folder).toBe('test-agent');
  });

  it('should find by folder', () => {
    createAgentGroup(ag());
    const result = getAgentGroupByFolder('test-agent');
    expect(result).toBeDefined();
    expect(result!.id).toBe('ag-1');
  });

  it('should list all', () => {
    createAgentGroup(ag());
    createAgentGroup({ ...ag(), id: 'ag-2', name: 'Another', folder: 'another' });
    expect(getAllAgentGroups()).toHaveLength(2);
  });

  it('should update', () => {
    createAgentGroup(ag());
    updateAgentGroup('ag-1', { name: 'Updated' });
    expect(getAgentGroup('ag-1')!.name).toBe('Updated');
  });

  it('should delete', () => {
    createAgentGroup(ag());
    deleteAgentGroup('ag-1');
    expect(getAgentGroup('ag-1')).toBeUndefined();
  });

  it('should enforce unique folder', () => {
    createAgentGroup(ag());
    expect(() => createAgentGroup({ ...ag(), id: 'ag-dup' })).toThrow();
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

  it('should create and retrieve', () => {
    createMessagingGroup(mg());
    const result = getMessagingGroup('mg-1');
    expect(result).toBeDefined();
    expect(result!.channel_type).toBe('discord');
  });

  it('should find by platform', () => {
    createMessagingGroup(mg());
    const result = getMessagingGroupByPlatform('discord', 'chan-123');
    expect(result).toBeDefined();
    expect(result!.id).toBe('mg-1');
  });

  it('should enforce unique channel_type + platform_id', () => {
    createMessagingGroup(mg());
    expect(() => createMessagingGroup({ ...mg(), id: 'mg-dup' })).toThrow();
  });

  it('should update', () => {
    createMessagingGroup(mg());
    updateMessagingGroup('mg-1', { name: 'Updated' });
    expect(getMessagingGroup('mg-1')!.name).toBe('Updated');
  });

  it('should delete', () => {
    createMessagingGroup(mg());
    deleteMessagingGroup('mg-1');
    expect(getMessagingGroup('mg-1')).toBeUndefined();
  });
});

// ── Messaging Group Agents ──

describe('messaging group agents', () => {
  beforeEach(() => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Agent',
      folder: 'agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
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

  it('should create and list by messaging group', () => {
    createMessagingGroupAgent(mga());
    const results = getMessagingGroupAgents('mg-1');
    expect(results).toHaveLength(1);
    expect(results[0].agent_group_id).toBe('ag-1');
  });

  it('should order by priority descending', () => {
    createMessagingGroupAgent(mga());
    createAgentGroup({
      id: 'ag-2',
      name: 'Agent2',
      folder: 'agent2',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroupAgent({ ...mga(), id: 'mga-2', agent_group_id: 'ag-2', priority: 10 });
    const results = getMessagingGroupAgents('mg-1');
    expect(results[0].agent_group_id).toBe('ag-2');
    expect(results[1].agent_group_id).toBe('ag-1');
  });

  it('should enforce unique messaging_group + agent_group', () => {
    createMessagingGroupAgent(mga());
    expect(() => createMessagingGroupAgent({ ...mga(), id: 'mga-dup' })).toThrow();
  });

  it('should update', () => {
    createMessagingGroupAgent(mga());
    updateMessagingGroupAgent('mga-1', { priority: 5 });
    expect(getMessagingGroupAgent('mga-1')!.priority).toBe(5);
  });

  it('should delete', () => {
    createMessagingGroupAgent(mga());
    deleteMessagingGroupAgent('mga-1');
    expect(getMessagingGroupAgents('mg-1')).toHaveLength(0);
  });

  it('should enforce foreign key on agent_group_id', () => {
    expect(() => createMessagingGroupAgent({ ...mga(), agent_group_id: 'nonexistent' })).toThrow();
  });

  it('auto-creates an agent_destinations row for the wiring', async () => {
    const { getDestinationByTarget, getDestinations } =
      await import('../modules/agent-to-agent/db/agent-destinations.js');
    createMessagingGroupAgent(mga());

    const dest = getDestinationByTarget('ag-1', 'channel', 'mg-1');
    expect(dest).toBeDefined();
    expect(dest!.local_name).toBe('gen'); // normalized from mg.name='Gen'
    expect(getDestinations('ag-1')).toHaveLength(1);
  });

  it('does not duplicate destination row on re-wiring', async () => {
    const { getDestinations } = await import('../modules/agent-to-agent/db/agent-destinations.js');
    createMessagingGroupAgent(mga());
    // Re-create the same wiring throws (PK unique), but even if we got the
    // row in some other way (e.g. via createDestination directly followed
    // by createMessagingGroupAgent), we should not end up with two rows.
    deleteMessagingGroupAgent('mga-1');
    createMessagingGroupAgent(mga());
    expect(getDestinations('ag-1')).toHaveLength(1);
  });

  it('breaks local_name collisions within an agent group', async () => {
    const { getDestinations } = await import('../modules/agent-to-agent/db/agent-destinations.js');
    // Two messaging groups with the same `name` wired to the same agent
    // should get distinct local_names (gen, gen-2).
    createMessagingGroupAgent(mga());
    createMessagingGroup({
      id: 'mg-2',
      channel_type: 'discord',
      platform_id: 'chan-2',
      name: 'Gen',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    createMessagingGroupAgent({ ...mga(), id: 'mga-2', messaging_group_id: 'mg-2' });

    const dests = getDestinations('ag-1')
      .map((d) => d.local_name)
      .sort();
    expect(dests).toEqual(['gen', 'gen-2']);
  });
});

// ── Sessions ──

describe('sessions', () => {
  beforeEach(() => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Agent',
      folder: 'agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
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

  it('should create and retrieve', () => {
    createSession(sess());
    const result = getSession('sess-1');
    expect(result).toBeDefined();
    expect(result!.agent_group_id).toBe('ag-1');
  });

  it('should find by messaging group (shared, no thread)', () => {
    createSession(sess());
    const result = findSession('mg-1', null);
    expect(result).toBeDefined();
    expect(result!.id).toBe('sess-1');
  });

  it('should find by messaging group + thread', () => {
    createSession({ ...sess(), thread_id: 'thread-1' });
    expect(findSession('mg-1', 'thread-1')).toBeDefined();
    expect(findSession('mg-1', 'thread-2')).toBeUndefined();
    expect(findSession('mg-1', null)).toBeUndefined();
  });

  it('should only find active sessions', () => {
    createSession({ ...sess(), status: 'closed' });
    expect(findSession('mg-1', null)).toBeUndefined();
  });

  it('should list by agent group', () => {
    createSession(sess());
    createSession({ ...sess(), id: 'sess-2', thread_id: 'thread-1' });
    expect(getSessionsByAgentGroup('ag-1')).toHaveLength(2);
  });

  it('should list active sessions', () => {
    createSession(sess());
    createSession({ ...sess(), id: 'sess-closed', status: 'closed', thread_id: 'thread-x' });
    expect(getActiveSessions()).toHaveLength(1);
  });

  it('should list running sessions', () => {
    createSession({ ...sess(), container_status: 'running' });
    createSession({ ...sess(), id: 'sess-idle', container_status: 'idle', thread_id: 'thread-1' });
    createSession({ ...sess(), id: 'sess-stopped', container_status: 'stopped', thread_id: 'thread-2' });
    expect(getRunningSessions()).toHaveLength(2);
  });

  it('should update', () => {
    createSession(sess());
    updateSession('sess-1', { container_status: 'running', last_active: now() });
    const result = getSession('sess-1')!;
    expect(result.container_status).toBe('running');
    expect(result.last_active).not.toBeNull();
  });

  it('should delete', () => {
    createSession(sess());
    deleteSession('sess-1');
    expect(getSession('sess-1')).toBeUndefined();
  });
});

// ── Pending Questions ──

describe('pending questions', () => {
  beforeEach(() => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Agent',
      folder: 'agent',
      agent_provider: null,
      created_at: now(),
    });
    createSession({
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

  it('should create and retrieve', () => {
    createPendingQuestion({
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
    const result = getPendingQuestion('q-1');
    expect(result).toBeDefined();
    expect(result!.session_id).toBe('sess-1');
    expect(result!.title).toBe('Test');
    expect(result!.options[0].value).toBe('yes');
  });

  it('should delete', () => {
    createPendingQuestion({
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
    deletePendingQuestion('q-1');
    expect(getPendingQuestion('q-1')).toBeUndefined();
  });
});
