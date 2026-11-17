/**
 * Group-scope enforcement must hold for every spelling of a scope arg: the
 * guard has to decide on the same keys and values the handler reads, so a
 * dash/underscore alias, an empty value, or a "__proto__" key cannot widen
 * a group-scoped agent's reach. Real resources and DB, agent caller.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const approvals = vi.hoisted(() => ({ requestApproval: vi.fn() }));

vi.mock('../modules/approvals/index.js', () => ({
  registerApprovalHandler: vi.fn(),
  requestApproval: approvals.requestApproval,
}));

vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../container-restart.js', () => ({
  restartAgentGroupContainers: vi.fn().mockResolvedValue(0),
}));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cli-group-scope-args' };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-group-scope-args';

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../db/index.js';
import { ensureContainerConfig, getContainerConfig } from '../db/container-configs.js';
import { createPendingApproval, createSession, getPendingApproval } from '../db/sessions.js';
import { dispatch } from './dispatch.js';
import type { CallerContext, ResponseFrame } from './frame.js';
import { parseArgv } from './parse-argv.js';
// Side-effect imports: register the real `destinations-*` and `groups-*` commands.
import './resources/destinations.js';
import './resources/groups.js';

const OWN = 'ag-own';
const OTHER = 'ag-other';
const SESSION = 'sess-own';

const agent: CallerContext = { caller: 'agent', sessionId: SESSION, agentGroupId: OWN, messagingGroupId: 'mg-own' };

function now(): string {
  return new Date().toISOString();
}

async function listDestinations(args: Record<string, unknown>, ctx: CallerContext = agent): Promise<ResponseFrame> {
  return dispatch({ id: 'req-list', command: 'destinations-list', args }, ctx);
}

function groupsIn(res: ResponseFrame): string[] {
  if (!res.ok) return [];
  return [...new Set((res.data as Array<{ agent_group_id: string }>).map((row) => row.agent_group_id))].sort();
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  approvals.requestApproval.mockReset();

  const db = await initTestDb();
  await runMigrations(db);
  for (const id of [OWN, OTHER]) {
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
    await ensureContainerConfig(id);
  }
  await getDb().run(
    `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES (?, 'peer', 'agent', ?, ?), (?, 'peer', 'agent', ?, ?)`,
    OWN,
    OTHER,
    now(),
    OTHER,
    OWN,
    now(),
  );
  await createSession({
    id: SESSION,
    agent_group_id: OWN,
    messaging_group_id: null,
    thread_id: 'test:group-scope-args',
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('group-scoped agent: scope args', () => {
  it('lists only its own group by default, and its own id in either spelling', async () => {
    expect(groupsIn(await listDestinations({}))).toEqual([OWN]);
    expect(groupsIn(await listDestinations({ agent_group_id: OWN }))).toEqual([OWN]);
    expect(groupsIn(await listDestinations({ 'agent-group-id': OWN }))).toEqual([OWN]);
    // Approval frames queued by older hosts carry both spellings, equal.
    expect(groupsIn(await listDestinations({ 'agent-group-id': OWN, agent_group_id: OWN }))).toEqual([OWN]);
    // null is "not given": auto-fill replaces it with the caller's group.
    expect(groupsIn(await listDestinations({ agent_group_id: null }))).toEqual([OWN]);
  });

  it.each([
    ['agent_group_id', OTHER],
    ['agent-group-id', OTHER],
    ['agent_group-id', OTHER],
    ['group', OTHER],
    ['id', OTHER],
  ])('denies a foreign group in --%s', async (key, value) => {
    const res = await listDestinations({ [key]: value });
    expect(groupsIn(res)).toEqual([]);
    expect(res).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });

  it.each([
    ['agent_group_id', ''],
    ['agent-group-id', ''],
    ['group', ''],
    ['id', ''],
    ['agent_group_id', 0],
    ['agent_group_id', false],
    ['agent_group_id', [OWN]],
  ])('denies a present-but-empty or non-string --%s (%j) instead of dropping the scope', async (key, value) => {
    const res = await listDestinations({ [key]: value });
    expect(groupsIn(res)).toEqual([]);
    expect(res).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });

  it('refuses two spellings of the scope flag instead of letting key order pick one', async () => {
    for (const args of [
      { agent_group_id: OWN, 'agent-group-id': OTHER },
      { 'agent-group-id': OTHER, agent_group_id: OWN },
      { 'agent-group-id': OWN, 'agent_group-id': OTHER },
    ]) {
      const res = await listDestinations(args);
      expect(groupsIn(res)).toEqual([]);
      expect(res.ok).toBe(false);
    }
  });

  it('refuses an id that is empty on an approval-gated groups verb before asking an admin', async () => {
    const res = await dispatch(
      { id: 'req-create', command: 'groups-create', args: { template: 'some-plugin', id: '' } },
      agent,
    );
    expect(res).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(approvals.requestApproval).not.toHaveBeenCalled();
  });
});

describe('group-scoped agent: argv as typed', () => {
  async function run(...argv: string[]): Promise<ResponseFrame> {
    const { command, args } = parseArgv(argv);
    return dispatch({ id: 'req-argv', command, args }, agent);
  }

  it('a repeated flag resolves to its last value, and the guard sees that value', async () => {
    const res = await run('destinations', 'list', '--agent_group_id', OWN, '--agent_group_id', OTHER);
    expect(groupsIn(res)).toEqual([]);
    expect(res).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(groupsIn(await run('destinations', 'list', '--agent-group-id', OTHER, '--agent-group-id', OWN))).toEqual([
      OWN,
    ]);
  });

  it('denies a value-less scope flag and a flag given in both spellings', async () => {
    expect(await run('destinations', 'list', '--agent-group-id')).toMatchObject({ ok: false });
    const both = await run('destinations', 'list', '--agent_group_id', OWN, '--agent-group-id', OTHER);
    expect(groupsIn(both)).toEqual([]);
    expect(both).toMatchObject({ ok: false, error: { code: 'invalid-args' } });
  });
});

describe('group-scoped agent: "__proto__" args', () => {
  // A cli_request arrives as parsed JSON, so "__proto__" is an ordinary own key.
  const smuggled = (key: string) => JSON.parse(`{"${key}": {"cli_scope": "global"}, "model": "m"}`);

  it.each(['__proto__', '--proto--'])('never mints an approval card for a %s key', async (key) => {
    const res = await dispatch({ id: 'req-1', command: 'groups-config-update', args: smuggled(key) }, agent);
    expect(res.ok).toBe(false);
    expect(res).not.toMatchObject({ error: { code: 'approval-pending' } });
    expect(approvals.requestApproval).not.toHaveBeenCalled();
  });

  it.each(['__proto__', '--proto--'])('an approved replay carrying %s cannot change cli_scope', async (key) => {
    const frame = { id: 'req-2', command: 'groups-config-update', args: smuggled(key) };
    await createPendingApproval({
      approval_id: 'appr-1',
      session_id: SESSION,
      request_id: frame.id,
      action: 'cli_command',
      payload: JSON.stringify({ frame, callerContext: agent }),
      created_at: now(),
      agent_group_id: OWN,
      title: 'CLI: groups-config-update',
      options_json: '[]',
    });
    const grant = (await getPendingApproval('appr-1'))!;

    const res = await dispatch(frame, agent, { grant });

    expect((await getContainerConfig(OWN))?.cli_scope).toBe('group');
    expect(res.ok).toBe(false);
  });
});

describe('host caller: scope args', () => {
  const host: CallerContext = { caller: 'host' };

  it('accepts either spelling', async () => {
    expect(groupsIn(await listDestinations({ 'agent-group-id': OTHER }, host))).toEqual([OTHER]);
    expect(groupsIn(await listDestinations({ agent_group_id: OTHER }, host))).toEqual([OTHER]);
  });

  it('refuses two spellings of one flag', async () => {
    const res = await listDestinations({ agent_group_id: OWN, 'agent-group-id': OTHER }, host);
    expect(groupsIn(res)).toEqual([]);
    expect(res).toMatchObject({ ok: false, error: { code: 'invalid-args' } });
  });
});
