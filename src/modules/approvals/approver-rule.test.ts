/**
 * mayResolve matrix — the one click-authorization rule for every hold.
 *
 * These cases pin the folded rule to the behavior of the three pre-fold
 * click-auth copies it replaces (approvals response handler, sender handler,
 * channel handler), so unifying them changes no click decision:
 *  - exclusive named approvers (a2a policy semantics: nobody else, not even
 *    an owner, may resolve)
 *  - admins-of-scope with and without a delivered approver (the
 *    sender/channel "named-or-admin" semantic)
 *  - the null-anchor variant (owners + global admins only)
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { upsertUser } from '../permissions/db/users.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { approverRuleOf, mayResolve } from './approver-rule.js';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-approver-rule' };
});

const TEST_DIR = '/tmp/nanoclaw-test-approver-rule';

function now() {
  return new Date().toISOString();
}

const OWNER = 'slack:owner';
const GLOBAL_ADMIN = 'slack:global-admin';
const SCOPED_ADMIN = 'slack:scoped-admin'; // admin @ ag-1
const OTHER_ADMIN = 'slack:other-admin'; // admin @ ag-2
const DELIVEREE = 'slack:deliveree'; // no role — the user a card was delivered to
const RANDO = 'slack:rando'; // no role

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({ id: 'ag-1', name: 'One', folder: 'one', agent_provider: null, created_at: now() });
  createAgentGroup({ id: 'ag-2', name: 'Two', folder: 'two', agent_provider: null, created_at: now() });

  for (const id of [OWNER, GLOBAL_ADMIN, SCOPED_ADMIN, OTHER_ADMIN, DELIVEREE, RANDO]) {
    upsertUser({ id, kind: 'slack', display_name: id, created_at: now() });
  }
  grantRole({ user_id: OWNER, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
  grantRole({ user_id: GLOBAL_ADMIN, role: 'admin', agent_group_id: null, granted_by: null, granted_at: now() });
  grantRole({ user_id: SCOPED_ADMIN, role: 'admin', agent_group_id: 'ag-1', granted_by: null, granted_at: now() });
  grantRole({ user_id: OTHER_ADMIN, role: 'admin', agent_group_id: 'ag-2', granted_by: null, granted_at: now() });
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('mayResolve matrix', () => {
  it('exclusive: only the named user, regardless of rank', () => {
    const e = { kind: 'exclusive', approverUserId: DELIVEREE } as const;
    expect(mayResolve(e, DELIVEREE)).toBe(true);
    expect(mayResolve(e, OWNER)).toBe(false);
    expect(mayResolve(e, GLOBAL_ADMIN)).toBe(false);
    expect(mayResolve(e, SCOPED_ADMIN)).toBe(false);
    expect(mayResolve(e, RANDO)).toBe(false);
    expect(mayResolve(e, null)).toBe(false);
  });

  it('admins-of-scope(group) with a delivered approver: named-or-admin', () => {
    const e = { kind: 'admins-of-scope', agentGroupId: 'ag-1', deliveredTo: DELIVEREE } as const;
    expect(mayResolve(e, DELIVEREE)).toBe(true); // delivered-to shortcut
    expect(mayResolve(e, SCOPED_ADMIN)).toBe(true);
    expect(mayResolve(e, GLOBAL_ADMIN)).toBe(true);
    expect(mayResolve(e, OWNER)).toBe(true);
    expect(mayResolve(e, OTHER_ADMIN)).toBe(false); // admin of another group
    expect(mayResolve(e, RANDO)).toBe(false);
    expect(mayResolve(e, null)).toBe(false);
  });

  it('admins-of-scope(group) without a delivered approver: pure admin chain', () => {
    const e = { kind: 'admins-of-scope', agentGroupId: 'ag-1', deliveredTo: null } as const;
    expect(mayResolve(e, SCOPED_ADMIN)).toBe(true);
    expect(mayResolve(e, GLOBAL_ADMIN)).toBe(true);
    expect(mayResolve(e, OWNER)).toBe(true);
    expect(mayResolve(e, DELIVEREE)).toBe(false);
    expect(mayResolve(e, OTHER_ADMIN)).toBe(false);
  });

  it('admins-of-scope(null): owners and global admins only', () => {
    const e = { kind: 'admins-of-scope', agentGroupId: null, deliveredTo: null } as const;
    expect(mayResolve(e, OWNER)).toBe(true);
    expect(mayResolve(e, GLOBAL_ADMIN)).toBe(true);
    expect(mayResolve(e, SCOPED_ADMIN)).toBe(false);
    expect(mayResolve(e, RANDO)).toBe(false);
  });

  it('admins-of-scope(null) with a delivered approver keeps the delivered-to shortcut (channel semantics)', () => {
    const e = { kind: 'admins-of-scope', agentGroupId: null, deliveredTo: DELIVEREE } as const;
    expect(mayResolve(e, DELIVEREE)).toBe(true);
    expect(mayResolve(e, SCOPED_ADMIN)).toBe(false);
  });

  it('approverRuleOf maps row columns onto the rule', () => {
    const base = { agent_group_id: 'ag-1' };
    expect(approverRuleOf({ ...base, approver_rule: 'exclusive', approver_user_id: DELIVEREE })).toEqual({
      kind: 'exclusive',
      approverUserId: DELIVEREE,
    });
    expect(approverRuleOf({ ...base, approver_rule: 'admins-of-scope', approver_user_id: DELIVEREE })).toEqual({
      kind: 'admins-of-scope',
      agentGroupId: 'ag-1',
      deliveredTo: DELIVEREE,
    });
    expect(approverRuleOf({ ...base, approver_rule: 'admins-of-scope', approver_user_id: null })).toEqual({
      kind: 'admins-of-scope',
      agentGroupId: 'ag-1',
      deliveredTo: null,
    });
    // Corrupt exclusive rows must fail closed. Widening a missing assignee to
    // the admin chain would silently change the authorization policy.
    const malformedExclusive = approverRuleOf({
      ...base,
      approver_rule: 'exclusive',
      approver_user_id: null,
    });
    expect(malformedExclusive).toEqual({ kind: 'exclusive', approverUserId: null });
    expect(mayResolve(malformedExclusive, OWNER)).toBe(false);
    expect(mayResolve(malformedExclusive, GLOBAL_ADMIN)).toBe(false);
    expect(mayResolve(malformedExclusive, DELIVEREE)).toBe(false);
  });
});
