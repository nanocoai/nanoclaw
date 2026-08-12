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
import os from 'os';
import path from 'path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

// The add-mount tests below drive the stored mount through the real
// mount-security validator, which reads a module-level const for the allowlist
// path. Expose it as a getter over hoisted state so each test can point it at
// its own temp file.
const mountState = vi.hoisted(() => ({ allowlistPath: '' }));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-cli-groups',
    get MOUNT_ALLOWLIST_PATH() {
      return mountState.allowlistPath;
    },
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-groups';

import { initTestDb, closeDb, runMigrations, createAgentGroup, getDb } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { dispatch } from '../dispatch.js';
import { ensureContainerConfig, getContainerConfig } from '../../db/container-configs.js';
import { validateMount } from '../../modules/mount-security/index.js';
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

describe('groups config add-mount / remove-mount (host-only)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    runMigrations(initTestDb());
  });
  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('adds a mount idempotently and removes it (host caller)', async () => {
    const GID = 'ag-mount';
    createAgentGroup({ id: GID, name: 'm', folder: 'm', agent_provider: null, created_at: now() });
    ensureContainerConfig(GID);
    // Relative, as mount-security requires — an absolute container path is
    // rejected at add time now, and was silently dropped at spawn before that.
    const args = { id: GID, host: '/data/.gmail-mcp', container: '.gmail-mcp', ro: true };

    const add = await dispatch({ id: 'r1', command: 'groups-config-add-mount', args }, { caller: 'host' });
    expect(add.ok).toBe(true);
    expect(JSON.parse(getContainerConfig(GID)!.additional_mounts)).toEqual([
      { hostPath: '/data/.gmail-mcp', containerPath: '.gmail-mcp', readonly: true },
    ]);

    // idempotent: a second add does not duplicate
    await dispatch({ id: 'r2', command: 'groups-config-add-mount', args }, { caller: 'host' });
    expect(JSON.parse(getContainerConfig(GID)!.additional_mounts)).toHaveLength(1);

    const rm = await dispatch(
      {
        id: 'r3',
        command: 'groups-config-remove-mount',
        args: { id: GID, host: '/data/.gmail-mcp', container: '.gmail-mcp' },
      },
      { caller: 'host' },
    );
    expect(rm.ok).toBe(true);
    expect(JSON.parse(getContainerConfig(GID)!.additional_mounts)).toEqual([]);
  });
});

/**
 * The mount mode `add-mount` records, checked through to what the container
 * actually gets.
 *
 * These assertions cross into mount-security on purpose: the bug they cover
 * lived in the seam, not in either module. `add-mount` wrote `readonly` only
 * when `--ro` was passed, and the validator grants read-write only for
 * `readonly === false` — so an omitted `--ro`, which is how every skill that
 * needs a writable mount documents it (add-gmail-tool, add-gcal-tool), left the
 * key undefined and was silently forced read-only at spawn. Each module was
 * self-consistent; only the pair was wrong, so only a test spanning the pair
 * catches it.
 */
describe('groups config add-mount: the mount mode the operator asked for', () => {
  const GID = 'ag-mount-mode';
  /** A timestamp no write can produce, so "unchanged" is unambiguous. */
  const SENTINEL = '2020-01-01T00:00:00.000Z';
  let tmpDir: string;
  let rootDir: string;
  let repoDir: string;

  /** An allowlist whose single root permits read-write, so the mount's own
   *  request is the only thing that can decide the outcome. */
  function writeAllowlist(allowReadWrite: boolean): void {
    fs.writeFileSync(
      mountState.allowlistPath,
      JSON.stringify({ allowedRoots: [{ path: rootDir, allowReadWrite }], blockedPatterns: [] }),
    );
  }

  /** The mount as stored by the CLI — the exact shape the runner hands the validator. */
  function stored(): Array<{ hostPath: string; containerPath: string; readonly?: boolean }> {
    return JSON.parse(getContainerConfig(GID)!.additional_mounts);
  }

  async function addMount(extra: Record<string, unknown> = {}) {
    return dispatch(
      {
        id: `r-${Math.random()}`,
        command: 'groups-config-add-mount',
        args: { id: GID, host: repoDir, container: 'repo', ...extra },
      },
      { caller: 'host' },
    );
  }

  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    runMigrations(initTestDb());
    createAgentGroup({ id: GID, name: 'm', folder: 'm', agent_provider: null, created_at: now() });
    ensureContainerConfig(GID);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'add-mount-'));
    mountState.allowlistPath = path.join(tmpDir, 'mount-allowlist.json');
    rootDir = path.join(tmpDir, 'projects');
    repoDir = path.join(rootDir, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('records an explicit read-write request when --ro is absent', async () => {
    await addMount();
    // Not `undefined`. The validator reads this key by identity, so "absent"
    // and "false" are different answers to "did the operator ask for write?".
    expect(stored()).toEqual([{ hostPath: repoDir, containerPath: 'repo', readonly: false }]);
  });

  it('a mount added without --ro is mounted read-write', async () => {
    writeAllowlist(true);
    await addMount();
    expect(validateMount(stored()[0])).toMatchObject({ allowed: true, effectiveReadonly: false });
  });

  it('still forces read-only when the allowlist root refuses write, whatever the mount asked for', async () => {
    // The allowlist stays the authority — this fix makes read-write reachable,
    // not automatic.
    writeAllowlist(false);
    await addMount();
    expect(validateMount(stored()[0])).toMatchObject({ allowed: true, effectiveReadonly: true });
  });

  it('honours --ro against a root that would have permitted write', async () => {
    writeAllowlist(true);
    await addMount({ ro: true });
    expect(stored()[0].readonly).toBe(true);
    expect(validateMount(stored()[0])).toMatchObject({ allowed: true, effectiveReadonly: true });
  });

  it('reads an explicit --ro false as read-write, not as the truthy string "false"', async () => {
    // `--ro` alone parses to boolean true, but `--ro false` parses to the
    // string "false" (src/cli/client.ts), which a bare truthiness check would
    // read as read-only — the opposite of what was typed. Same convention as
    // src/cli/crud.ts.
    writeAllowlist(true);
    await addMount({ ro: 'false' });
    expect(stored()[0].readonly).toBe(false);
    expect(validateMount(stored()[0])).toMatchObject({ allowed: true, effectiveReadonly: false });
  });

  it('reads a value it does not recognise as read-write, the same as every other boolean flag', async () => {
    // The rest of the CLI decides a boolean flag by what it recognises as true
    // (`true` / `'true'` / `'1'` — src/cli/crud.ts, src/cli/resources/tasks.ts,
    // src/cli/resources/wirings.ts), not by ruling out the spellings of false.
    // Inverting that here would make this one flag read `--ro banana` as
    // read-only while the same input is false everywhere else.
    writeAllowlist(true);
    await addMount({ ro: 'banana' });
    expect(stored()[0].readonly).toBe(false);
  });

  it('re-adding the same mount with a different mode updates it instead of keeping the stale one', async () => {
    // The dedupe key is host+container, so without this the operator's second
    // command is a silent no-op — and correcting a wrong mode is exactly why
    // anyone re-runs add-mount.
    await addMount();
    await addMount({ ro: true });
    expect(stored()).toEqual([{ hostPath: repoDir, containerPath: 'repo', readonly: true }]);

    await addMount();
    expect(stored()).toEqual([{ hostPath: repoDir, containerPath: 'repo', readonly: false }]);
  });

  it('leaves the row untouched when the re-run asks for nothing new', async () => {
    // `updateContainerConfigJson` stamps `updated_at` on every call, so writing
    // unconditionally makes an idempotent re-run look like a config edit that
    // never happened. Stamped with a sentinel rather than compared against the
    // first write's timestamp: two writes can land in the same millisecond, and
    // that would pass while the write still happened.
    await addMount();
    getDb().prepare('UPDATE container_configs SET updated_at = ? WHERE agent_group_id = ?').run(SENTINEL, GID);

    await addMount();

    expect(getContainerConfig(GID)!.updated_at).toBe(SENTINEL);
    expect(stored()).toEqual([{ hostPath: repoDir, containerPath: 'repo', readonly: false }]);
  });

  it('records the edit when the re-run does change the mode', async () => {
    // The other half of the same rule: skipping the no-op must not turn into
    // skipping every re-run of an entry that already exists.
    await addMount();
    getDb().prepare('UPDATE container_configs SET updated_at = ? WHERE agent_group_id = ?').run(SENTINEL, GID);

    await addMount({ ro: true });

    expect(getContainerConfig(GID)!.updated_at).not.toBe(SENTINEL);
  });

  it('reports the mode it stored, so the operator does not have to re-read the config', async () => {
    const resp = await addMount();
    expect((resp as { ok: true; data: { added: unknown } }).data.added).toEqual({
      hostPath: repoDir,
      containerPath: 'repo',
      readonly: false,
    });
  });
});

/**
 * What `add-mount` promises the operator versus what the mount will do.
 *
 * `add-mount` does not validate. It stores the entry, answers `ok`, and returns
 * a note telling the operator to restart "for the mount to take effect". The
 * decision about whether the mount can take effect at all happens later, at
 * spawn, inside `validateAdditionalMounts` — where a rejection is a `log.warn`
 * on the host and nothing else. Nothing is written back to the config, nothing
 * reaches the operator, and the container comes up looking healthy with the
 * directory simply absent.
 *
 * Most rejection reasons are deployment facts that can legitimately be fixed
 * after the fact — the host path may not exist yet, the allowlist may not cover
 * it yet — so refusing them at add time would be wrong. But an absolute
 * `--container` path is not one of those. `isValidContainerPath` rejects it
 * unconditionally, on every host, forever; no later edit to the allowlist or
 * the filesystem can make that mount work. Accepting it and reporting success
 * is the verb telling the operator something that is not true.
 *
 * This is not hypothetical on either side. `.claude/skills/add-rtk/SKILL.md:53`
 * documents exactly this invocation, and the "adds a mount idempotently"
 * test above uses `--container /home/node/.gmail-mcp` as its fixture — so the
 * suite's own canonical example of "a mount" is one that can never mount.
 */
describe('groups config add-mount: mounts that can never take effect', () => {
  const GID = 'ag-mount-unmountable';

  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    runMigrations(initTestDb());
    createAgentGroup({ id: GID, name: 'm', folder: 'm', agent_provider: null, created_at: now() });
    ensureContainerConfig(GID);
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  async function addMount(container: string) {
    return dispatch(
      {
        id: `r-${container}`,
        command: 'groups-config-add-mount',
        args: { id: GID, host: '/data/.gmail-mcp', container },
      },
      { caller: 'host' },
    );
  }

  it('refuses an absolute --container path instead of confirming it', async () => {
    // Independently of this verb: the validator will never accept this shape.
    expect(validateMount({ hostPath: '/data/.gmail-mcp', containerPath: '/home/node/.gmail-mcp' })).toMatchObject({
      allowed: false,
    });

    const resp = await addMount('/home/node/.gmail-mcp');

    expect(resp.ok).toBe(false);
    expect((resp as { ok: false; error: { message: string } }).error.message).toMatch(/relative|absolute/i);
  });

  it('does not store an absolute --container path it cannot honour', async () => {
    await addMount('/home/node/.gmail-mcp');
    // Otherwise the config carries a permanently dead entry that every future
    // spawn re-rejects, and `ncl groups config get` shows it as configured.
    expect(JSON.parse(getContainerConfig(GID)!.additional_mounts)).toEqual([]);
  });

  it('still accepts the relative form the working skills document', async () => {
    // The guard must reject the unfixable shape only — this is the invocation
    // add-gmail-tool and add-gcal-tool document, and it has to keep working.
    const resp = await addMount('.gmail-mcp');
    expect(resp.ok).toBe(true);
    expect(JSON.parse(getContainerConfig(GID)!.additional_mounts)).toEqual([
      { hostPath: '/data/.gmail-mcp', containerPath: '.gmail-mcp', readonly: false },
    ]);
  });
});

describe('groups CLI MCP config', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    runMigrations(initTestDb());
    createAgentGroup({
      id: 'ag-mcp',
      name: 'mcp',
      folder: 'mcp',
      agent_provider: null,
      created_at: now(),
    });
    ensureContainerConfig('ag-mcp');
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('adds stdio and HTTPS MCP servers through the same command', async () => {
    const local = await dispatch(
      {
        id: 'req-local',
        command: 'groups-config-add-mcp-server',
        args: { id: 'ag-mcp', name: 'local', command: 'pnpm', args: '["dlx","server"]' },
      },
      { caller: 'host' },
    );
    const remote = await dispatch(
      {
        id: 'req-remote',
        command: 'groups-config-add-mcp-server',
        args: { id: 'ag-mcp', name: 'remote', url: 'https://mcp.example.com/mcp' },
      },
      { caller: 'host' },
    );

    expect(local.ok).toBe(true);
    expect(remote.ok).toBe(true);
    expect(JSON.parse(getContainerConfig('ag-mcp')!.mcp_servers)).toEqual({
      local: { command: 'pnpm', args: ['dlx', 'server'], env: {} },
      remote: { type: 'http', url: 'https://mcp.example.com/mcp' },
    });
  });

  it('rejects ambiguous and insecure remote MCP config', async () => {
    const both = await dispatch(
      {
        id: 'req-both',
        command: 'groups-config-add-mcp-server',
        args: { id: 'ag-mcp', name: 'bad', command: 'server', url: 'https://mcp.example.com/mcp' },
      },
      { caller: 'host' },
    );
    const insecure = await dispatch(
      {
        id: 'req-http',
        command: 'groups-config-add-mcp-server',
        args: { id: 'ag-mcp', name: 'bad', url: 'http://mcp.example.com/mcp' },
      },
      { caller: 'host' },
    );

    expect(both.ok).toBe(false);
    expect(both.ok ? '' : both.error.message).toMatch(/exactly one/);
    expect(insecure.ok).toBe(false);
    expect(insecure.ok ? '' : insecure.error.message).toMatch(/HTTPS/);
  });

  it('rejects a server name that fails the shared name validation', async () => {
    const badName = await dispatch(
      {
        id: 'req-bad-name',
        command: 'groups-config-add-mcp-server',
        args: { id: 'ag-mcp', name: 'docs]\n[mcp_servers.evil]', url: 'https://mcp.example.com/mcp' },
      },
      { caller: 'host' },
    );

    expect(badName.ok).toBe(false);
    expect(badName.ok ? '' : badName.error.message).toMatch(/1-64 characters/);
    expect(JSON.parse(getContainerConfig('ag-mcp')!.mcp_servers)).toEqual({});
  });
});
