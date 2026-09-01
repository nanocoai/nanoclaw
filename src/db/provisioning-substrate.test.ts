/**
 * Guard tests for the provisioning substrate:
 *
 * - the three schema migrations (users.email, agent_groups.provisioned_user_id,
 *   users.onecli_project_id) registered in the migration barrel,
 * - the DB helpers that read/write the new columns (createUser / upsertUser
 *   email persistence, setUserProjectId, getUserByDmMessagingGroup,
 *   getUserDmByMessagingGroup, createAgentGroup provisioned_user_id),
 * - the `ncl` surface (users email / onecli_project_id fields through real
 *   dispatch(), and the `user-dms ensure` verb registration).
 *
 * Round-trip shape: fresh in-memory DB → runMigrations → write through the
 * real helpers / dispatch() → read back. Goes red if a migration drops out of
 * the barrel, a column is renamed, a helper is deleted, or a CLI field/verb
 * registration drifts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { initTestDb, closeDb, getDb } from './connection.js';
import { runMigrations } from './migrations/index.js';
import { createAgentGroup, getAgentGroup } from './agent-groups.js';
import { createMessagingGroup } from './messaging-groups.js';
import {
  createUser,
  upsertUser,
  getUser,
  setUserProjectId,
  getUserByDmMessagingGroup,
} from '../modules/permissions/db/users.js';
import { upsertUserDm, getUserDmByMessagingGroup } from '../modules/permissions/db/user-dms.js';
import { dispatch } from '../cli/dispatch.js';
// Side-effect imports: register the `users-*` / `user-dms-*` commands.
import '../cli/resources/users.js';
import '../cli/resources/user-dms.js';

function now(): string {
  return new Date().toISOString();
}

async function columnNames(table: string): Promise<string[]> {
  return (await getDb().all<{ name: string }>(`PRAGMA table_info(${table})`)).map((column) => column.name);
}

beforeEach(async () => {
  // initTestDb only opens the in-memory DB — the SQLite driver has no
  // prepareTestSchema, so the schema exists only once migrations run.
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
});

describe('provisioning migrations (019–021)', () => {
  it('adds users.email, users.onecli_project_id, agent_groups.provisioned_user_id', async () => {
    const users = await columnNames('users');
    expect(users).toContain('email');
    expect(users).toContain('onecli_project_id');
    expect(await columnNames('agent_groups')).toContain('provisioned_user_id');
  });

  it('is idempotent — running migrations again does not throw', async () => {
    await runMigrations(getDb());
  });
});

describe('users helpers round-trip the new columns', () => {
  it('createUser persists email; getUser reads it back', async () => {
    await createUser({ id: 'slack:U1', kind: 'slack', display_name: 'One', email: 'one@corp.example', created_at: now() });
    const user = await getUser('slack:U1');
    expect(user?.email).toBe('one@corp.example');
  });

  it('createUser tolerates an absent email (NULL outside provisioning)', async () => {
    await createUser({ id: 'slack:U2', kind: 'slack', display_name: null, created_at: now() });
    expect((await getUser('slack:U2'))?.email).toBeNull();
  });

  it('upsertUser COALESCEs email — a later upsert without email keeps the provisioned one', async () => {
    await upsertUser({ id: 'slack:U3', kind: 'slack', display_name: null, email: 'three@corp.example', created_at: now() });
    await upsertUser({ id: 'slack:U3', kind: 'slack', display_name: 'Three', created_at: now() });
    const user = await getUser('slack:U3');
    expect(user?.display_name).toBe('Three');
    expect(user?.email).toBe('three@corp.example');
  });

  it('setUserProjectId persists the OneCLI project id', async () => {
    await createUser({ id: 'slack:U4', kind: 'slack', display_name: null, created_at: now() });
    await setUserProjectId('slack:U4', 'proj_abc123');
    expect((await getUser('slack:U4'))?.onecli_project_id).toBe('proj_abc123');
  });
});

describe('agent_groups.provisioned_user_id', () => {
  it('createAgentGroup persists provisioned_user_id when supplied', async () => {
    await createAgentGroup({
      id: 'ag-prov',
      name: 'prov',
      folder: 'prov',
      agent_provider: null,
      created_at: now(),
      provisioned_user_id: 'slack:U9',
    });
    expect((await getAgentGroup('ag-prov'))?.provisioned_user_id).toBe('slack:U9');
  });

  it('createAgentGroup defaults provisioned_user_id to NULL when omitted', async () => {
    await createAgentGroup({ id: 'ag-plain', name: 'plain', folder: 'plain', agent_provider: null, created_at: now() });
    expect((await getAgentGroup('ag-plain'))?.provisioned_user_id).toBeNull();
  });
});

describe('DM reverse lookups through user_dms', () => {
  beforeEach(async () => {
    await createUser({ id: 'slack:U5', kind: 'slack', display_name: null, email: 'five@corp.example', created_at: now() });
    await setUserProjectId('slack:U5', 'proj_five');
    await createMessagingGroup({
      id: 'mg-dm-5',
      channel_type: 'slack',
      platform_id: 'D555',
      name: null,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    await upsertUserDm({ user_id: 'slack:U5', channel_type: 'slack', messaging_group_id: 'mg-dm-5', resolved_at: now() });
  });

  it('getUserByDmMessagingGroup resolves the DM owner (with provisioned columns)', async () => {
    const user = await getUserByDmMessagingGroup('mg-dm-5');
    expect(user?.id).toBe('slack:U5');
    expect(user?.onecli_project_id).toBe('proj_five');
  });

  it('getUserDmByMessagingGroup resolves the user_dms row', async () => {
    expect((await getUserDmByMessagingGroup('mg-dm-5'))?.user_id).toBe('slack:U5');
  });

  it('both return undefined for a messaging group that is no known user DM', async () => {
    expect(await getUserByDmMessagingGroup('mg-nope')).toBeUndefined();
    expect(await getUserDmByMessagingGroup('mg-nope')).toBeUndefined();
  });
});

describe('ncl surface', () => {
  it('users create/update accept email and onecli_project_id', async () => {
    const created = await dispatch(
      {
        id: 'req-u-create',
        command: 'users-create',
        args: { id: 'slack:U6', kind: 'slack', email: 'six@corp.example' },
      },
      { caller: 'host' },
    );
    expect(created.ok).toBe(true);
    expect((await getUser('slack:U6'))?.email).toBe('six@corp.example');

    // Update must accept BOTH declared fields — `email` and `onecli_project_id`
    // are each marked updatable; dropping either declaration goes red here.
    const updated = await dispatch(
      {
        id: 'req-u-update',
        command: 'users-update',
        args: { id: 'slack:U6', onecli_project_id: 'proj_six', email: 'six-updated@corp.example' },
      },
      { caller: 'host' },
    );
    expect(updated.ok).toBe(true);
    expect((await getUser('slack:U6'))?.onecli_project_id).toBe('proj_six');
    expect((await getUser('slack:U6'))?.email).toBe('six-updated@corp.example');
  });

  it('user-dms ensure is registered (rejects a call without --user)', async () => {
    const resp = await dispatch({ id: 'req-ensure', command: 'user-dms-ensure', args: {} }, { caller: 'host' });
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      // The verb's own validation — an unregistered verb would say "unknown command".
      expect(resp.error.message).toContain('--user is required');
    }
  });

  it('user-dms ensure resolves the cached DM route for --user (no adapter round trip)', async () => {
    // Cache-first happy path: with a user_dms row in place, ensureUserDm
    // returns the cached messaging group before touching any channel adapter,
    // so this drives the real handler → ensureUserDm → DB chain end to end.
    // Goes red if the handler's `--user` arg mapping or the ensureUserDm call
    // drifts, not just if the verb registration is deleted.
    await createUser({ id: 'slack:U7', kind: 'slack', display_name: null, created_at: now() });
    await createMessagingGroup({
      id: 'mg-dm-7',
      channel_type: 'slack',
      platform_id: 'D777',
      name: null,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    await upsertUserDm({ user_id: 'slack:U7', channel_type: 'slack', messaging_group_id: 'mg-dm-7', resolved_at: now() });

    const resp = await dispatch(
      { id: 'req-ensure-hit', command: 'user-dms-ensure', args: { user: 'slack:U7' } },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(true);
    if (resp.ok) expect((resp.data as { id: string }).id).toBe('mg-dm-7');
  });
});
