import type { UserRole, UserRoleKind } from '../../../types.js';
import { getDb } from '../../../db/connection.js';

/**
 * Grant a role. Owner rows must have agent_group_id = null (enforced here,
 * not by schema, so callers get a clean error path).
 */
export async function grantRole(row: UserRole): Promise<void> {
  if (row.role === 'owner' && row.agent_group_id !== null) {
    throw new Error('owner role must be global (agent_group_id = null)');
  }
  await getDb().run(
    `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
     VALUES (@user_id, @role, @agent_group_id, @granted_by, @granted_at)`,
    row,
  );
}

export async function revokeRole(userId: string, role: UserRoleKind, agentGroupId: string | null): Promise<void> {
  if (agentGroupId === null) {
    await getDb().run('DELETE FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id IS NULL', userId, role);
  } else {
    await getDb().run(
      'DELETE FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id = ?',
      userId,
      role,
      agentGroupId,
    );
  }
}

export async function getUserRoles(userId: string): Promise<UserRole[]> {
  return getDb().all<UserRole>('SELECT * FROM user_roles WHERE user_id = ?', userId);
}

export async function isOwner(userId: string): Promise<boolean> {
  const row = await getDb().get(
    'SELECT 1 FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id IS NULL LIMIT 1',
    userId,
    'owner',
  );
  return !!row;
}

export async function isGlobalAdmin(userId: string): Promise<boolean> {
  const row = await getDb().get(
    'SELECT 1 FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id IS NULL LIMIT 1',
    userId,
    'admin',
  );
  return !!row;
}

export async function isAdminOfAgentGroup(userId: string, agentGroupId: string): Promise<boolean> {
  const row = await getDb().get(
    'SELECT 1 FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id = ? LIMIT 1',
    userId,
    'admin',
    agentGroupId,
  );
  return !!row;
}

/** Any admin privilege over this agent group: global admin OR scoped admin. */
export async function hasAdminPrivilege(userId: string, agentGroupId: string): Promise<boolean> {
  return (await isOwner(userId)) || (await isGlobalAdmin(userId)) || (await isAdminOfAgentGroup(userId, agentGroupId));
}

export async function getOwners(): Promise<UserRole[]> {
  return getDb().all<UserRole>(
    'SELECT * FROM user_roles WHERE role = ? AND agent_group_id IS NULL ORDER BY granted_at',
    'owner',
  );
}

export async function hasAnyOwner(): Promise<boolean> {
  const row = await getDb().get('SELECT 1 FROM user_roles WHERE role = ? AND agent_group_id IS NULL LIMIT 1', 'owner');
  return !!row;
}

export async function getGlobalAdmins(): Promise<UserRole[]> {
  return getDb().all<UserRole>(
    'SELECT * FROM user_roles WHERE role = ? AND agent_group_id IS NULL ORDER BY granted_at',
    'admin',
  );
}

export async function getAdminsOfAgentGroup(agentGroupId: string): Promise<UserRole[]> {
  return getDb().all<UserRole>(
    'SELECT * FROM user_roles WHERE role = ? AND agent_group_id = ? ORDER BY granted_at',
    'admin',
    agentGroupId,
  );
}
