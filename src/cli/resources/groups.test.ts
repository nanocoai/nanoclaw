/**
 * Regression test for #2525 — `ncl groups delete` must cascade dependent
 * rows in FK order so the final `DELETE FROM agent_groups` succeeds even
 * when the group has sessions, destinations, approvals, role grants, etc.
 *
 * The bug pre-fix: the generic single-table DELETE handler ran a bare
 * `DELETE FROM agent_groups WHERE id = ?` which always failed with a
 * `SQLITE_CONSTRAINT_FOREIGNKEY` when anything pointed at the group.
 *
 * The approval handler in `dispatch.ts` re-enters `dispatch()` with
 * `caller: 'host'` after admin approval, so the test invokes dispatch
 * with the host caller — same code path a real approval would take.
 */
import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cli-groups' };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-groups';

import { initTestDb, closeDb, runMigrations, createAgentGroup, getDb } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers the `groups-*` commands (including delete).
import './groups.js';

function now(): string {
  return new Date().toISOString();
}

function count(sql: string, ...params: unknown[]): number {
  return (
    getDb()
      .prepare(sql)
      .get(...params) as { c: number }
  ).c;
}

describe('groups CLI delete cascades dependent rows (#2525)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('deletes a group with sessions, destinations, approvals, members, roles, and wirings', async () => {
    const GID = 'ag-victim';
    const SID = 'sess-victim-1';
    const MGID = 'mg-1';
    const UID = 'tg:42';

    createAgentGroup({ id: GID, name: 'victim', folder: 'victim', agent_provider: null, created_at: now() });
    createSession({
      id: SID,
      agent_group_id: GID,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });

    const db = getDb();

    // Direct inserts for the dependent tables. Keeps the fixture minimal —
    // we only need rows that establish FK relationships, not full domain
    // entities.
    db.prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'telegram', 'someone', ?)`).run(
      UID,
      now(),
    );
    db.prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, 'telegram', 'tg-1', 'telegram', 'chat', 1, 'strict', ?)`,
    ).run(MGID, now());

    db.prepare(
      `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES (?, 'chan', 'channel', ?, ?)`,
    ).run(GID, MGID, now());

    db.prepare(
      `INSERT INTO pending_questions (question_id, session_id, message_out_id, title, options_json, created_at)
       VALUES (?, ?, 'mout-1', 'q', '[]', ?)`,
    ).run('q-1', SID, now());

    db.prepare(
      `INSERT INTO pending_approvals (approval_id, session_id, request_id, action, payload, created_at, agent_group_id, status, title, options_json)
       VALUES (?, ?, 'req-1', 'cli_command', '{}', ?, ?, 'pending', '', '[]')`,
    ).run('pa-1', SID, now(), GID);

    db.prepare(
      `INSERT INTO pending_sender_approvals (id, messaging_group_id, agent_group_id, sender_identity, sender_name, original_message, approver_user_id, created_at)
       VALUES ('psa-1', ?, ?, 'tg:99', 'them', '{}', ?, ?)`,
    ).run(MGID, GID, UID, now());

    db.prepare(
      `INSERT INTO pending_channel_approvals (messaging_group_id, agent_group_id, original_message, approver_user_id, created_at)
       VALUES (?, ?, '{}', ?, ?)`,
    ).run(MGID, GID, UID, now());

    db.prepare(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, sender_scope, ignored_message_policy, session_mode, priority, created_at)
       VALUES ('mga-1', ?, ?, 'mention', 'all', 'drop', 'shared', 0, ?)`,
    ).run(MGID, GID, now());

    db.prepare(
      `INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, NULL, ?)`,
    ).run(UID, GID, now());

    db.prepare(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, 'admin', ?, NULL, ?)`,
    ).run(UID, GID, now());

    // Container config row exercises the ON DELETE CASCADE on container_configs.
    db.prepare(
      `INSERT INTO container_configs
         (agent_group_id, provider, model, effort, image_tag, assistant_name, max_messages_per_prompt,
          skills, mcp_servers, packages_apt, packages_npm, additional_mounts, cli_scope, updated_at)
       VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL, '"all"', '{}', '[]', '[]', '[]', 'group', ?)`,
    ).run(GID, now());

    const resp = await dispatch({ id: 'req-del', command: 'groups-delete', args: { id: GID } }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: { deleted: string; removed: Record<string, number> } }).data;
    expect(data.deleted).toBe(GID);
    expect(data.removed).toMatchObject({
      sessions: 1,
      pending_questions: 1,
      pending_approvals: 1,
      agent_destinations_owned: 1,
      agent_destinations_pointing: 0,
      pending_sender_approvals: 1,
      pending_channel_approvals: 1,
      messaging_group_agents: 1,
      agent_group_members: 1,
      user_roles: 1,
      container_configs: 1,
    });

    // The group and every dependent row must be gone.
    expect(count('SELECT COUNT(*) AS c FROM agent_groups WHERE id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM sessions WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM pending_questions WHERE session_id = ?', SID)).toBe(0);
    expect(
      count('SELECT COUNT(*) AS c FROM pending_approvals WHERE agent_group_id = ? OR session_id = ?', GID, SID),
    ).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM agent_destinations WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM pending_sender_approvals WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM pending_channel_approvals WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM messaging_group_agents WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM agent_group_members WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM user_roles WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM container_configs WHERE agent_group_id = ?', GID)).toBe(0);

    // Unrelated tables untouched.
    expect(count('SELECT COUNT(*) AS c FROM users WHERE id = ?', UID)).toBe(1);
    expect(count('SELECT COUNT(*) AS c FROM messaging_groups WHERE id = ?', MGID)).toBe(1);
  });

  it('removes polymorphic agent_destinations that point at the deleted group', async () => {
    const A = 'ag-a';
    const B = 'ag-b';
    createAgentGroup({ id: A, name: 'a', folder: 'a', agent_provider: null, created_at: now() });
    createAgentGroup({ id: B, name: 'b', folder: 'b', agent_provider: null, created_at: now() });

    const db = getDb();

    // B has a destination pointing at A. target_id is polymorphic — no FK
    // constraint enforces it, so without explicit cleanup the row would
    // dangle after A is deleted.
    db.prepare(
      `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES (?, 'sibling', 'agent', ?, ?)`,
    ).run(B, A, now());

    const resp = await dispatch({ id: 'req-del-a', command: 'groups-delete', args: { id: A } }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: { removed: Record<string, number> } }).data;
    expect(data.removed.agent_destinations_pointing).toBe(1);

    // A is gone, B remains, and B's stale destination is cleaned up.
    expect(count('SELECT COUNT(*) AS c FROM agent_groups WHERE id = ?', A)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM agent_groups WHERE id = ?', B)).toBe(1);
    expect(count('SELECT COUNT(*) AS c FROM agent_destinations WHERE agent_group_id = ?', B)).toBe(0);
  });

  it('returns a handler error for an unknown group id', async () => {
    const resp = await dispatch(
      { id: 'req-missing', command: 'groups-delete', args: { id: 'ag-does-not-exist' } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(false);
    expect((resp as { ok: false; error: { code: string; message: string } }).error.code).toBe('handler-error');
    expect((resp as { ok: false; error: { code: string; message: string } }).error.message).toMatch(/not found/i);
  });
});

/**
 * `groups config add-mount` / `groups config remove-mount` manage the
 * `additional_mounts` JSON column on `container_configs`. Mirrors the
 * `config add-package` / `config remove-package` shape: --id required,
 * getContainerConfig row lookup, updateContainerConfigJson write-back.
 */
describe('groups CLI config add-mount / remove-mount', () => {
  const GID = 'ag-mounts';

  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = initTestDb();
    runMigrations(db);

    createAgentGroup({ id: GID, name: 'mounts', folder: 'mounts', agent_provider: null, created_at: now() });
    db.prepare(
      `INSERT INTO container_configs
         (agent_group_id, provider, model, effort, image_tag, assistant_name, max_messages_per_prompt,
          skills, mcp_servers, packages_apt, packages_npm, additional_mounts, cli_scope, updated_at)
       VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL, '"all"', '{}', '[]', '[]', '[]', 'group', ?)`,
    ).run(GID, now());
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  function mountsFor(id: string): Array<{ hostPath: string; containerPath: string; readonly?: boolean }> {
    const row = getDb().prepare('SELECT additional_mounts FROM container_configs WHERE agent_group_id = ?').get(id) as {
      additional_mounts: string;
    };
    return JSON.parse(row.additional_mounts);
  }

  it('add-mount creates an entry with a default container-path (basename of host path)', async () => {
    const resp = await dispatch(
      { id: 'req-1', command: 'groups-config-add-mount', args: { id: GID, 'host-path': '/home/user/data' } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: { mounts: unknown[]; note: string } }).data;
    expect(data.mounts).toEqual([{ hostPath: '/home/user/data', containerPath: 'data', readonly: false }]);
    expect(data.note).toMatch(/next container spawn/);
    expect(data.note).toMatch(/mount-allowlist\.json/);
    expect(data.note).toMatch(/groups restart --id/);
    expect(mountsFor(GID)).toEqual([{ hostPath: '/home/user/data', containerPath: 'data', readonly: false }]);
  });

  it('add-mount without --readonly stores an explicit readonly: false (never omits the key)', async () => {
    // mount-security (src/modules/mount-security/index.ts:336) only grants
    // read-write when it sees `readonly === false` on the stored entry — an
    // omitted key is silently forced read-only. The handler must always
    // write the key.
    await dispatch(
      { id: 'req-1b', command: 'groups-config-add-mount', args: { id: GID, 'host-path': '/home/user/data' } },
      { caller: 'host' },
    );

    const [mount] = mountsFor(GID);
    expect(mount).toHaveProperty('readonly', false);
    expect(Object.prototype.hasOwnProperty.call(mount, 'readonly')).toBe(true);
  });

  it('add-mount accepts an explicit container-path and --readonly', async () => {
    const resp = await dispatch(
      {
        id: 'req-2',
        command: 'groups-config-add-mount',
        args: { id: GID, 'host-path': '/home/user/data', 'container-path': 'mydata', readonly: true },
      },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    expect(mountsFor(GID)).toEqual([{ hostPath: '/home/user/data', containerPath: 'mydata', readonly: true }]);
  });

  it('add-mount no-ops on a duplicate hostPath but still returns the current list', async () => {
    await dispatch(
      { id: 'req-3a', command: 'groups-config-add-mount', args: { id: GID, 'host-path': '/home/user/data' } },
      { caller: 'host' },
    );
    const resp = await dispatch(
      {
        id: 'req-3b',
        command: 'groups-config-add-mount',
        args: { id: GID, 'host-path': '/home/user/data', 'container-path': 'other' },
      },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: { mounts: unknown[] } }).data;
    // Unchanged — the second call's differing --container-path is ignored.
    expect(data.mounts).toEqual([{ hostPath: '/home/user/data', containerPath: 'data', readonly: false }]);
    expect(mountsFor(GID)).toHaveLength(1);
  });

  it('add-mount rejects a relative host path', async () => {
    const resp = await dispatch(
      { id: 'req-4', command: 'groups-config-add-mount', args: { id: GID, 'host-path': 'relative/path' } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(false);
    expect((resp as { ok: false; error: { message: string } }).error.message).toMatch(/absolute/i);
    expect(mountsFor(GID)).toEqual([]);
  });

  it('add-mount rejects a container path containing a slash or ".."', async () => {
    const respSlash = await dispatch(
      {
        id: 'req-5a',
        command: 'groups-config-add-mount',
        args: { id: GID, 'host-path': '/home/user/data', 'container-path': 'a/b' },
      },
      { caller: 'host' },
    );
    expect(respSlash.ok).toBe(false);
    expect((respSlash as { ok: false; error: { message: string } }).error.message).toMatch(/bare name/i);

    const respDotDot = await dispatch(
      {
        id: 'req-5b',
        command: 'groups-config-add-mount',
        args: { id: GID, 'host-path': '/home/user/data', 'container-path': '..' },
      },
      { caller: 'host' },
    );
    expect(respDotDot.ok).toBe(false);
    expect((respDotDot as { ok: false; error: { message: string } }).error.message).toMatch(/bare name/i);

    const respColon = await dispatch(
      {
        id: 'req-5c',
        command: 'groups-config-add-mount',
        args: { id: GID, 'host-path': '/home/user/data', 'container-path': 'a:b' },
      },
      { caller: 'host' },
    );
    expect(respColon.ok).toBe(false);
    expect((respColon as { ok: false; error: { message: string } }).error.message).toMatch(/bare name/i);

    expect(mountsFor(GID)).toEqual([]);
  });

  it('add-mount rejects a second mount whose container path collides (same basename)', async () => {
    await dispatch(
      { id: 'req-5d', command: 'groups-config-add-mount', args: { id: GID, 'host-path': '/home/user/data' } },
      { caller: 'host' },
    );

    // Same basename, different host path → both would land at /workspace/extra/data
    const collision = await dispatch(
      { id: 'req-5e', command: 'groups-config-add-mount', args: { id: GID, 'host-path': '/mnt/other/data' } },
      { caller: 'host' },
    );
    expect(collision.ok).toBe(false);
    expect((collision as { ok: false; error: { message: string } }).error.message).toMatch(
      /already used by mount \/home\/user\/data/,
    );

    // A distinct --container-path resolves the collision
    const resolved = await dispatch(
      {
        id: 'req-5f',
        command: 'groups-config-add-mount',
        args: { id: GID, 'host-path': '/mnt/other/data', 'container-path': 'other-data' },
      },
      { caller: 'host' },
    );
    expect(resolved.ok).toBe(true);
    expect(mountsFor(GID)).toEqual([
      { hostPath: '/home/user/data', containerPath: 'data', readonly: false },
      { hostPath: '/mnt/other/data', containerPath: 'other-data', readonly: false },
    ]);
  });

  it('add-mount requires --id and --host-path', async () => {
    const respNoId = await dispatch(
      { id: 'req-6a', command: 'groups-config-add-mount', args: { 'host-path': '/home/user/data' } },
      { caller: 'host' },
    );
    expect(respNoId.ok).toBe(false);
    expect((respNoId as { ok: false; error: { message: string } }).error.message).toMatch(/--id is required/);

    const respNoHostPath = await dispatch(
      { id: 'req-6b', command: 'groups-config-add-mount', args: { id: GID } },
      { caller: 'host' },
    );
    expect(respNoHostPath.ok).toBe(false);
    expect((respNoHostPath as { ok: false; error: { message: string } }).error.message).toMatch(
      /--host-path is required/,
    );
  });

  it('remove-mount filters the array by hostPath', async () => {
    await dispatch(
      { id: 'req-7a', command: 'groups-config-add-mount', args: { id: GID, 'host-path': '/home/user/data' } },
      { caller: 'host' },
    );
    await dispatch(
      { id: 'req-7b', command: 'groups-config-add-mount', args: { id: GID, 'host-path': '/home/user/other' } },
      { caller: 'host' },
    );

    const resp = await dispatch(
      { id: 'req-7c', command: 'groups-config-remove-mount', args: { id: GID, 'host-path': '/home/user/data' } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: { mounts: unknown[]; note: string } }).data;
    expect(data.mounts).toEqual([{ hostPath: '/home/user/other', containerPath: 'other', readonly: false }]);
    expect(data.note).toMatch(/groups restart --id/);
    expect(mountsFor(GID)).toEqual([{ hostPath: '/home/user/other', containerPath: 'other', readonly: false }]);
  });

  it('remove-mount requires --id and --host-path', async () => {
    const respNoId = await dispatch(
      { id: 'req-8a', command: 'groups-config-remove-mount', args: { 'host-path': '/home/user/data' } },
      { caller: 'host' },
    );
    expect(respNoId.ok).toBe(false);
    expect((respNoId as { ok: false; error: { message: string } }).error.message).toMatch(/--id is required/);

    const respNoHostPath = await dispatch(
      { id: 'req-8b', command: 'groups-config-remove-mount', args: { id: GID } },
      { caller: 'host' },
    );
    expect(respNoHostPath.ok).toBe(false);
    expect((respNoHostPath as { ok: false; error: { message: string } }).error.message).toMatch(
      /--host-path is required/,
    );
  });
});
