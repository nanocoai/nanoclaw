/**
 * Access control.
 *
 * Privilege is user-level, not group-level. A user holds zero or more roles
 * (owner | admin) via `user_roles`, and is optionally "known" in specific
 * agent groups via `agent_group_members`. Admins are implicitly members of
 * the groups they administer.
 *
 * Approver-picking (`pickApprover`, `pickApprovalDelivery`) lives in the
 * approvals module — see `src/modules/approvals/primitive.ts`.
 */
import { isMember } from './db/agent-group-members.js';
import { isAdminOfAgentGroup, isGlobalAdmin, isOwner } from './db/user-roles.js';
import { getUser } from './db/users.js';

export type AccessDecision =
  | { allowed: true; reason: 'owner' | 'global_admin' | 'admin_of_group' | 'member' }
  | { allowed: false; reason: 'unknown_user' | 'not_member' };

/** Can this user interact with this agent group? */
export async function canAccessAgentGroup(userId: string, agentGroupId: string): Promise<AccessDecision> {
  if (!(await getUser(userId))) return { allowed: false, reason: 'unknown_user' };
  if (await isOwner(userId)) return { allowed: true, reason: 'owner' };
  if (await isGlobalAdmin(userId)) return { allowed: true, reason: 'global_admin' };
  if (await isAdminOfAgentGroup(userId, agentGroupId)) return { allowed: true, reason: 'admin_of_group' };
  if (await isMember(userId, agentGroupId)) return { allowed: true, reason: 'member' };
  return { allowed: false, reason: 'not_member' };
}
