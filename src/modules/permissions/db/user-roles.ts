import type { UserRole, UserRoleKind } from '../../../types.js';
import { getDb } from '../../../db/connection.js';

// ---------------------------------------------------------------------------
// Privilege classification + self-describing capabilities
// ---------------------------------------------------------------------------

/**
 * Distinct privilege levels. A raw (role, agent_group_id) row is ambiguous on
 * its own — `admin` means very different things depending on whether the group
 * is null (global) or set (scoped). This collapses the pair into one explicit
 * identity so callers never have to re-derive the blast radius.
 */
export type RolePrivilege = 'owner' | 'global-admin' | 'group-admin';

export interface RoleScopeDescription {
  privilege: RolePrivilege;
  /**
   * Article-free label, e.g. "owner", "GLOBAL admin", "admin of group Foo".
   * Safe to drop into a sentence or an approval card (issue B reuses this).
   */
  label: string;
  /** One-line capability / blast-radius description. */
  capabilities: string;
}

/** Collapse a (role, agent_group_id) row into its explicit privilege level. */
export function classifyRole(role: UserRoleKind, agentGroupId: string | null): RolePrivilege {
  if (role === 'owner') return 'owner';
  return agentGroupId === null ? 'global-admin' : 'group-admin';
}

/**
 * Describe what a role grant confers in plain language. Kept in the
 * permissions module (not the CLI layer) so approval-card rendering (issue B)
 * and any future prompt/doc guidance (issue A4) can reuse the same wording.
 *
 * `groupName` is optional cosmetic sugar for group-scoped admins — pass the
 * resolved agent-group name when it's cheap; otherwise the raw id is used.
 */
export function describeRoleScope(
  role: UserRoleKind,
  agentGroupId: string | null,
  groupName?: string | null,
): RoleScopeDescription {
  const privilege = classifyRole(role, agentGroupId);
  switch (privilege) {
    case 'owner':
      return {
        privilege,
        label: 'owner',
        capabilities: 'full control over ALL agent groups — can approve any sensitive action and manage every group',
      };
    case 'global-admin':
      return {
        privilege,
        label: 'GLOBAL admin',
        capabilities: 'can approve sensitive actions and manage ALL agent groups',
      };
    case 'group-admin': {
      const where = groupName ?? agentGroupId ?? '(unknown group)';
      return {
        privilege,
        label: `admin of group ${where}`,
        capabilities: 'can approve sensitive actions and manage this group only',
      };
    }
  }
}

/**
 * Grant a role. Owner rows must have agent_group_id = null (enforced here,
 * not by schema, so callers get a clean error path).
 */
export function grantRole(row: UserRole): void {
  if (row.role === 'owner' && row.agent_group_id !== null) {
    throw new Error('owner role must be global (agent_group_id = null)');
  }
  getDb()
    .prepare(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
       VALUES (@user_id, @role, @agent_group_id, @granted_by, @granted_at)`,
    )
    .run(row);
}

export function revokeRole(userId: string, role: UserRoleKind, agentGroupId: string | null): void {
  if (agentGroupId === null) {
    getDb()
      .prepare('DELETE FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id IS NULL')
      .run(userId, role);
  } else {
    getDb()
      .prepare('DELETE FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id = ?')
      .run(userId, role, agentGroupId);
  }
}

export function getUserRoles(userId: string): UserRole[] {
  return getDb().prepare('SELECT * FROM user_roles WHERE user_id = ?').all(userId) as UserRole[];
}

export function isOwner(userId: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id IS NULL LIMIT 1')
    .get(userId, 'owner');
  return !!row;
}

export function isGlobalAdmin(userId: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id IS NULL LIMIT 1')
    .get(userId, 'admin');
  return !!row;
}

export function isAdminOfAgentGroup(userId: string, agentGroupId: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id = ? LIMIT 1')
    .get(userId, 'admin', agentGroupId);
  return !!row;
}

/** Any admin privilege over this agent group: global admin OR scoped admin. */
export function hasAdminPrivilege(userId: string, agentGroupId: string): boolean {
  return isOwner(userId) || isGlobalAdmin(userId) || isAdminOfAgentGroup(userId, agentGroupId);
}

export function getOwners(): UserRole[] {
  return getDb()
    .prepare('SELECT * FROM user_roles WHERE role = ? AND agent_group_id IS NULL ORDER BY granted_at')
    .all('owner') as UserRole[];
}

export function hasAnyOwner(): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM user_roles WHERE role = ? AND agent_group_id IS NULL LIMIT 1')
    .get('owner');
  return !!row;
}

export function getGlobalAdmins(): UserRole[] {
  return getDb()
    .prepare('SELECT * FROM user_roles WHERE role = ? AND agent_group_id IS NULL ORDER BY granted_at')
    .all('admin') as UserRole[];
}

export function getAdminsOfAgentGroup(agentGroupId: string): UserRole[] {
  return getDb()
    .prepare('SELECT * FROM user_roles WHERE role = ? AND agent_group_id = ? ORDER BY granted_at')
    .all('admin', agentGroupId) as UserRole[];
}
