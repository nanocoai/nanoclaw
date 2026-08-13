import type { UserRole, UserRoleKind } from '../../../types.js';
import { getDb } from '../../../db/connection.js';

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

/**
 * True when `userId` is the sole remaining global owner — revoking their owner
 * role would leave zero owners, an unrecoverable state (no one could ever
 * approve an owner-level action again).
 */
export function isLastOwner(userId: string): boolean {
  const owners = getOwners();
  return owners.length === 1 && owners[0].user_id === userId;
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
