/**
 * Behavior tests for `ncl groups purge` (groups-purge skill) — the full
 * teardown verb. Extends the delete cascade with container kill, per-group
 * image removal, and on-disk cleanup. The external side-effects (kill / rmi)
 * are mocked via the teardown-module mock below; the DB cascade and on-disk
 * cleanup run for real against the temp dirs.
 *
 * Drives the real CLI entry: the side-effect import of `./groups.js` registers
 * the `groups-*` commands (including purge), and every test goes through
 * `dispatch()` with the host caller — same code path an approved request
 * takes. Goes red if the purge wiring in groups.ts is removed or drifts.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../modules/groups-purge/teardown.js', () => ({
  removeImage: vi.fn(),
  killGroupContainers: vi.fn().mockResolvedValue(0),
  deleteAgentGroupImage: vi.fn().mockReturnValue(false),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-cli-groups-purge',
    GROUPS_DIR: '/tmp/nanoclaw-test-cli-groups-purge/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-groups-purge';
const TEST_GROUPS_DIR = '/tmp/nanoclaw-test-cli-groups-purge/groups';
const TEST_SESSIONS_DIR = '/tmp/nanoclaw-test-cli-groups-purge/v2-sessions';

import { initTestDb, closeDb, runMigrations, createAgentGroup, getDb } from '../../db/index.js';
import { isContainerRunning, killContainer } from '../../container-runner.js';
import { createSession } from '../../db/sessions.js';
import { sqliteRaw } from '../../db/drivers/sqlite.js';
import { deleteAgentGroupImage, killGroupContainers } from '../../modules/groups-purge/teardown.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers the `groups-*` commands (including purge).
import './groups.js';

function now(): string {
  return new Date().toISOString();
}

async function count(sql: string, ...params: unknown[]): Promise<number> {
  return (await getDb().get<{ c: number }>(sql, ...params))!.c;
}

describe('groups CLI purge (full teardown)', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = await initTestDb();
    await runMigrations(db);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  async function seedGroup(id: string, folder: string): Promise<void> {
    await createAgentGroup({ id, name: folder, folder, agent_provider: null, created_at: now() });
  }

  it('kills containers, removes image + dirs, cascades DB, and preserves shared identity', async () => {
    const GID = 'ag-purge';
    const SID = 'sess-purge-1';
    const MGID = 'mg-purge';
    const UID = 'tg:77';
    const FOLDER = 'purgeme';

    await seedGroup(GID, FOLDER);
    await createSession({
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
    await db.run(
      `INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'telegram', 'someone', ?)`,
      UID,
      now(),
    );
    await db.run(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, 'telegram', 'tg-1', 'telegram', 'chat', 1, 'strict', ?)`,
      MGID,
      now(),
    );
    await db.run(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, sender_scope, ignored_message_policy, session_mode, priority, created_at)
       VALUES ('mga-p', ?, ?, 'mention', 'all', 'drop', 'shared', 0, ?)`,
      MGID,
      GID,
      now(),
    );
    await db.run(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, 'admin', ?, NULL, ?)`,
      UID,
      GID,
      now(),
    );
    await db.run(
      `INSERT INTO container_configs
         (agent_group_id, provider, model, effort, image_tag, assistant_name, max_messages_per_prompt,
          skills, mcp_servers, packages_apt, packages_npm, additional_mounts, cli_scope, updated_at)
       VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL, '"all"', '{}', '[]', '[]', '[]', 'group', ?)`,
      GID,
      now(),
    );

    // On-disk artifacts the purge must remove.
    const groupDir = path.join(TEST_GROUPS_DIR, FOLDER);
    const sessionsDir = path.join(TEST_SESSIONS_DIR, GID);
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), '# x');
    fs.mkdirSync(path.join(sessionsDir, SID), { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, SID, 'inbound.db'), 'x');

    // Mocked teardown side-effects report success.
    vi.mocked(killGroupContainers).mockResolvedValue(2);
    vi.mocked(deleteAgentGroupImage).mockReturnValue(true);

    const resp = await dispatch({ id: 'req-purge', command: 'groups-purge', args: { id: GID } }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      id: GID,
      killed_containers: 2,
      image_removed: true,
      dirs_removed: { group: true, sessions: true },
    });
    expect(data.db).toMatchObject({
      sessions: 1,
      messaging_group_agents: 1,
      user_roles: 1,
      container_configs: 1,
    });
    expect(data.notes).toBeUndefined();

    // Teardown side-effects invoked with the group id.
    expect(killGroupContainers).toHaveBeenCalledWith(GID, expect.any(String));
    expect(deleteAgentGroupImage).toHaveBeenCalledWith(GID);

    // On-disk dirs gone.
    expect(fs.existsSync(groupDir)).toBe(false);
    expect(fs.existsSync(sessionsDir)).toBe(false);

    // DB rows gone; shared identity preserved (parity with delete).
    expect(await count('SELECT COUNT(*) AS c FROM agent_groups WHERE id = ?', GID)).toBe(0);
    expect(await count('SELECT COUNT(*) AS c FROM sessions WHERE agent_group_id = ?', GID)).toBe(0);
    expect(await count('SELECT COUNT(*) AS c FROM messaging_group_agents WHERE agent_group_id = ?', GID)).toBe(0);
    expect(await count('SELECT COUNT(*) AS c FROM user_roles WHERE agent_group_id = ?', GID)).toBe(0);
    expect(await count('SELECT COUNT(*) AS c FROM container_configs WHERE agent_group_id = ?', GID)).toBe(0);
    expect(await count('SELECT COUNT(*) AS c FROM users WHERE id = ?', UID)).toBe(1);
    expect(await count('SELECT COUNT(*) AS c FROM messaging_groups WHERE id = ?', MGID)).toBe(1);
  });

  it('is idempotent when image and dirs are already absent', async () => {
    const GID = 'ag-purge-empty';
    await seedGroup(GID, 'emptyfolder');
    vi.mocked(killGroupContainers).mockResolvedValue(0);
    vi.mocked(deleteAgentGroupImage).mockReturnValue(false);

    const resp = await dispatch(
      { id: 'req-purge-empty', command: 'groups-purge', args: { id: GID } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: Record<string, unknown> }).data;
    expect(data.image_removed).toBe(false);
    // force:true rm of a non-existent dir does not throw → reported removed.
    expect(data.dirs_removed).toEqual({ group: true, sessions: true });
    expect(await count('SELECT COUNT(*) AS c FROM agent_groups WHERE id = ?', GID)).toBe(0);
  });

  it('still runs the DB cascade when an external step throws (best-effort)', async () => {
    const GID = 'ag-purge-flaky';
    await seedGroup(GID, 'flaky');
    vi.mocked(killGroupContainers).mockRejectedValue(new Error('docker down'));
    vi.mocked(deleteAgentGroupImage).mockReturnValue(false);

    const resp = await dispatch(
      { id: 'req-purge-flaky', command: 'groups-purge', args: { id: GID } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: { notes?: string[] } }).data;
    expect(data.notes).toEqual(expect.arrayContaining([expect.stringContaining('kill: docker down')]));
    // Cascade still removed the group despite the kill failure.
    expect(await count('SELECT COUNT(*) AS c FROM agent_groups WHERE id = ?', GID)).toBe(0);
  });

  it('returns a handler error for an unknown group id', async () => {
    const resp = await dispatch(
      { id: 'req-purge-missing', command: 'groups-purge', args: { id: 'ag-nope' } },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(false);
    expect((resp as { ok: false; error: { code: string; message: string } }).error.message).toMatch(/not found/i);
  });

  it('the delete cascade covers every central-DB table scoped by agent_group_id', () => {
    // Drift guard for the cascade extraction: the groups.ts edit anchors on
    // the `db.transaction` statement, which still matches after upstream
    // CHANGES the cascade body (e.g. adds a newly introduced group-scoped
    // table, as it historically did with pending_approvals and
    // agent_destinations). That must fail loudly here — not be silently
    // replaced by this skill's frozen copy of the cascade. Enumerate every
    // migrated table carrying an agent_group_id-scoped column and require the
    // set to exactly match what cascadeDeleteGroup covers.
    const db = sqliteRaw(getDb());
    const scoped = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    )
      .map((t) => t.name)
      .filter((name) =>
        (db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).some(
          (c) => c.name === 'agent_group_id' || c.name.endsWith('_agent_group_id'),
        ),
      )
      .sort();

    // Tables cascadeDeleteGroup deletes from — the CascadeCounts keys, with
    // the two agent_destinations counts folded into their one table…
    const cascadeCovered = [
      'agent_destinations',
      'agent_group_members',
      'container_configs',
      'messaging_group_agents',
      'pending_approvals',
      'pending_channel_approvals',
      'pending_sender_approvals',
      'sessions',
      'user_roles',
    ];
    // …plus the rows upstream's `delete` deliberately leaves behind (policy
    // and audit history) — purge keeps parity with delete there. If a table
    // moves between these lists, or a new one appears, reconcile
    // cascadeDeleteGroup with upstream's delete handler before updating this.
    const knownUncovered = ['agent_message_policies', 'unregistered_senders'];

    expect(scoped).toEqual([...cascadeCovered, ...knownUncovered].sort());
  });

  it("killGroupContainers (real module) kills exactly the group's running sessions", async () => {
    // The teardown module's consumption of core is runtime DB state — drive
    // the REAL killGroupContainers against the real migrated sessions table,
    // mocking only the docker edge (isContainerRunning / killContainer).
    const teardown = await vi.importActual<typeof import('../../modules/groups-purge/teardown.js')>(
      '../../modules/groups-purge/teardown.js',
    );

    await seedGroup('ag-kill', 'killme');
    await seedGroup('ag-other', 'otherfolder');
    const mkSession = (id: string, gid: string): Promise<void> =>
      createSession({
        id,
        agent_group_id: gid,
        messaging_group_id: null,
        thread_id: null,
        agent_provider: null,
        status: 'active',
        container_status: 'stopped',
        last_active: null,
        created_at: now(),
      });
    await mkSession('sess-kill-running', 'ag-kill');
    await mkSession('sess-kill-stopped', 'ag-kill');
    await mkSession('sess-other-running', 'ag-other');

    vi.mocked(isContainerRunning).mockImplementation((id: string) => id.endsWith('-running'));
    try {
      const killed = await teardown.killGroupContainers('ag-kill', 'purge test');
      expect(killed).toBe(1);
      expect(killContainer).toHaveBeenCalledTimes(1);
      expect(killContainer).toHaveBeenCalledWith('sess-kill-running', 'purge test');
    } finally {
      vi.mocked(isContainerRunning).mockReturnValue(false);
    }
  });
});
