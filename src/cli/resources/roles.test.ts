/**
 * Last-owner hard stop for `ncl roles revoke`.
 *
 * The global `owner` (agent_group_id = null) is the root of trust; reaching
 * zero owners is unrecoverable, so revoking the sole remaining owner must be
 * refused outright with NO database change. This must hold on every path that
 * reaches the revoke handler — the guard lives in the handler itself, so the
 * test drives it through `dispatch()` with a host caller, the same code path a
 * post-approval replay takes.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { initTestDb, closeDb, runMigrations, getDb } from '../../db/index.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers the `roles-*` commands (including revoke).
import './roles.js';

function now(): string {
  return new Date().toISOString();
}

function addUser(id: string): void {
  getDb()
    .prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'telegram', ?, ?)`)
    .run(id, id, now());
}

function grantOwner(userId: string): void {
  getDb()
    .prepare(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
       VALUES (?, 'owner', NULL, NULL, ?)`,
    )
    .run(userId, now());
}

function grantGlobalAdmin(userId: string): void {
  getDb()
    .prepare(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
       VALUES (?, 'admin', NULL, NULL, ?)`,
    )
    .run(userId, now());
}

function count(sql: string, ...params: unknown[]): number {
  return (
    getDb()
      .prepare(sql)
      .get(...params) as { c: number }
  ).c;
}

function revoke(user: string, role: string, group?: string) {
  const args: Record<string, unknown> = { user, role };
  if (group !== undefined) args.group = group;
  return dispatch({ id: 'req-revoke', command: 'roles-revoke', args }, { caller: 'host' });
}

describe('roles revoke — last-owner hard stop', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
  });

  it('refuses to revoke the sole remaining owner and makes no DB change', async () => {
    addUser('u1');
    grantOwner('u1');

    const resp = await revoke('u1', 'owner');

    expect(resp.ok).toBe(false);
    expect((resp as { ok: false; error: { code: string; message: string } }).error.code).toBe('handler-error');
    expect((resp as { ok: false; error: { message: string } }).error.message).toMatch(
      /cannot revoke the last remaining owner/i,
    );

    // The owner row must still be present — no DB change.
    expect(count(`SELECT COUNT(*) AS c FROM user_roles WHERE user_id = 'u1' AND role = 'owner'`)).toBe(1);
  });

  it('allows revoking one of several owners, leaving the others', async () => {
    addUser('u1');
    addUser('u2');
    grantOwner('u1');
    grantOwner('u2');

    const resp = await revoke('u1', 'owner');

    expect(resp.ok).toBe(true);
    expect(count(`SELECT COUNT(*) AS c FROM user_roles WHERE user_id = 'u1' AND role = 'owner'`)).toBe(0);
    expect(count(`SELECT COUNT(*) AS c FROM user_roles WHERE user_id = 'u2' AND role = 'owner'`)).toBe(1);
  });

  it('is unaffected when revoking a non-owner role even if only one owner exists', async () => {
    addUser('u1');
    addUser('u2');
    grantOwner('u1');
    grantGlobalAdmin('u2');

    const resp = await revoke('u2', 'admin');

    expect(resp.ok).toBe(true);
    expect(count(`SELECT COUNT(*) AS c FROM user_roles WHERE user_id = 'u2' AND role = 'admin'`)).toBe(0);
    // The sole owner is untouched.
    expect(count(`SELECT COUNT(*) AS c FROM user_roles WHERE user_id = 'u1' AND role = 'owner'`)).toBe(1);
  });

  it('returns "role not found" for a non-existent role (guard does not mask it)', async () => {
    addUser('u1');
    grantOwner('u1');

    // u1 has no admin role — the guard is owner-only, so the delete runs and
    // reports the normal not-found error.
    const resp = await revoke('u1', 'admin');

    expect(resp.ok).toBe(false);
    expect((resp as { ok: false; error: { message: string } }).error.message).toMatch(/role not found/i);
  });
});
