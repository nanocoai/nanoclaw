/**
 * Tests for issue A — role-grant scope must be an explicit, required choice,
 * and grant/revoke must return a plain-language scope/capability summary.
 *
 * The approval handler in `dispatch.ts` re-enters `dispatch()` with
 * `caller: 'host'` after admin approval, so these tests invoke dispatch with
 * the host caller — the same code path a real approval takes. (grant/revoke
 * are `access: 'approval'`, so an agent caller would only get an
 * approval-pending stub, never run the handler.)
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
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cli-roles' };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-roles';

import { initTestDb, closeDb, runMigrations, createAgentGroup, getDb } from '../../db/index.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers the `roles-grant` / `roles-revoke` commands.
import './roles.js';

function now(): string {
  return new Date().toISOString();
}

const GID = 'ag-team';
const UID = 'slack:U123';

function roleRows() {
  return getDb()
    .prepare('SELECT user_id, role, agent_group_id FROM user_roles ORDER BY role, agent_group_id')
    .all() as Array<{ user_id: string; role: string; agent_group_id: string | null }>;
}

async function grant(args: Record<string, unknown>) {
  return dispatch({ id: 'req', command: 'roles-grant', args }, { caller: 'host' });
}

async function revoke(args: Record<string, unknown>) {
  return dispatch({ id: 'req', command: 'roles-revoke', args }, { caller: 'host' });
}

describe('roles CLI grant/revoke require explicit scope (issue A)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = initTestDb();
    runMigrations(db);

    createAgentGroup({ id: GID, name: 'team', folder: 'team', agent_provider: null, created_at: now() });
    db.prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'slack', 'someone', ?)`).run(
      UID,
      now(),
    );
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('errors and writes nothing when --scope is omitted (no silent global grant)', async () => {
    const resp = await grant({ user: UID, role: 'admin' });
    expect(resp.ok).toBe(false);
    expect(resp.ok === false && resp.error.message).toMatch(/--scope is required/);
    expect(roleRows()).toEqual([]);
  });

  it('rejects an invalid --scope value', async () => {
    const resp = await grant({ user: UID, role: 'admin', scope: 'everywhere' });
    expect(resp.ok).toBe(false);
    // Upstream's crud framework enum-validates declared args before the handler
    // runs, so an invalid --scope is rejected with the uniform "must be one of"
    // message (roles.ts's own guard is now a defensive fallback). The intent —
    // invalid scope rejected, nothing written — is unchanged.
    expect(resp.ok === false && resp.error.message).toMatch(/scope must be one of: global, group/);
    expect(roleRows()).toEqual([]);
  });

  it('grants GLOBAL admin with --scope global and reports blast radius', async () => {
    const resp = await grant({ user: UID, role: 'admin', scope: 'global' });
    expect(resp.ok).toBe(true);
    const data = resp.ok && (resp.data as Record<string, unknown>);
    expect(data).toMatchObject({ user_id: UID, role: 'admin', agent_group_id: null, privilege: 'global-admin' });
    expect(String((data as Record<string, unknown>).summary)).toBe(
      `${UID} is now a GLOBAL admin — can approve sensitive actions and manage ALL agent groups.`,
    );
    expect(roleRows()).toEqual([{ user_id: UID, role: 'admin', agent_group_id: null }]);
  });

  it('rejects --scope global with a stray --group', async () => {
    const resp = await grant({ user: UID, role: 'admin', scope: 'global', group: GID });
    expect(resp.ok).toBe(false);
    expect(resp.ok === false && resp.error.message).toMatch(/do not also pass --group/);
    expect(roleRows()).toEqual([]);
  });

  it('grants group-scoped admin with --scope group --group and names the group', async () => {
    const resp = await grant({ user: UID, role: 'admin', scope: 'group', group: GID });
    expect(resp.ok).toBe(true);
    const data = resp.ok && (resp.data as Record<string, unknown>);
    expect(data).toMatchObject({
      user_id: UID,
      role: 'admin',
      agent_group_id: GID,
      agent_group_name: 'team',
      privilege: 'group-admin',
    });
    expect(String((data as Record<string, unknown>).summary)).toBe(
      `${UID} is now an admin of group team — can approve sensitive actions and manage this group only.`,
    );
    expect(roleRows()).toEqual([{ user_id: UID, role: 'admin', agent_group_id: GID }]);
  });

  it('rejects --scope group without --group', async () => {
    const resp = await grant({ user: UID, role: 'admin', scope: 'group' });
    expect(resp.ok).toBe(false);
    expect(resp.ok === false && resp.error.message).toMatch(/requires --group/);
    expect(roleRows()).toEqual([]);
  });

  it('rejects scoping owner to a group; grants owner globally', async () => {
    const bad = await grant({ user: UID, role: 'owner', scope: 'group', group: GID });
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.error.message).toMatch(/owner role is always global/);

    const ok = await grant({ user: UID, role: 'owner', scope: 'global' });
    expect(ok.ok).toBe(true);
    const data = ok.ok && (ok.data as Record<string, unknown>);
    expect(data).toMatchObject({ role: 'owner', agent_group_id: null, privilege: 'owner' });
    expect(String((data as Record<string, unknown>).summary)).toContain('is now the owner');
  });

  it('revoke needs explicit scope and targets only the matching grant', async () => {
    // Two distinct admin grants for the same user.
    await grant({ user: UID, role: 'admin', scope: 'global' });
    await grant({ user: UID, role: 'admin', scope: 'group', group: GID });
    expect(roleRows()).toHaveLength(2);

    // Omitting scope errors, leaving both rows intact.
    const noScope = await revoke({ user: UID, role: 'admin' });
    expect(noScope.ok).toBe(false);
    expect(roleRows()).toHaveLength(2);

    // Revoking global removes only the global row.
    const resp = await revoke({ user: UID, role: 'admin', scope: 'global' });
    expect(resp.ok).toBe(true);
    const data = resp.ok && (resp.data as Record<string, unknown>);
    expect(String((data as Record<string, unknown>).summary)).toContain('is no longer a GLOBAL admin');
    expect(roleRows()).toEqual([{ user_id: UID, role: 'admin', agent_group_id: GID }]);
  });

  it('revoke reports "role not found" for a scope with no grant', async () => {
    const resp = await revoke({ user: UID, role: 'admin', scope: 'global' });
    expect(resp.ok).toBe(false);
    expect(resp.ok === false && resp.error.message).toMatch(/role not found/);
  });
});
