/**
 * Approver rules — the one click-authorization rule for every hold.
 *
 * The hold-record contract (guarded-actions phase 1) is carried on the
 * existing tables: a hold has an id, an action, a payload, an approver
 * rule (who may resolve it), a restart policy, and an optional expiry. On
 * `pending_approvals` these map to `approval_id` / `action` / `payload` /
 * (`approver_rule` + `approver_user_id` + `agent_group_id`) / `expires_at`;
 * the restart policy is derived from the action (`onecli_credential` rows are
 * swept-and-denied on boot, everything else is durable and keeps waiting).
 * `pending_channel_approvals` maps through a synthesized view
 * (channel-approval.ts) — the channel flow keeps its own table.
 *
 * Two approver-rule kinds:
 *   - `exclusive` — only the named user may resolve (an a2a message policy's
 *     approver). Nobody else, including owners.
 *   - `admins-of-scope` — the admin chain of the anchoring agent group
 *     (scoped admin / global admin / owner), or owners + global admins when
 *     the anchor is null. When the hold records the user the card was
 *     delivered to, that user may also resolve — the sender/channel
 *     "named-or-admin" semantic, preserved verbatim from the pre-fold tables.
 *
 * `mayResolve` replaces the three divergent click-auth copies (approvals
 * response handler, sender handler, channel handler) with one function.
 */
import type { ApproverRule, PendingApproval } from '../../types.js';
import { hasAdminPrivilege, isGlobalAdmin, isOwner } from '../permissions/db/user-roles.js';

export type { ApproverRule } from '../../types.js';

/** May `clickerUserId` (namespaced `<channel>:<handle>`) resolve a hold with this approver rule? */
export function mayResolve(e: ApproverRule, clickerUserId: string | null): boolean {
  if (!clickerUserId) return false;

  if (e.kind === 'exclusive') {
    return clickerUserId === e.approverUserId;
  }

  return (
    (e.deliveredTo !== null && clickerUserId === e.deliveredTo) ||
    (e.agentGroupId
      ? hasAdminPrivilege(clickerUserId, e.agentGroupId)
      : isOwner(clickerUserId) || isGlobalAdmin(clickerUserId))
  );
}

/** The approver rule a `pending_approvals` row encodes. */
export function approverRuleOf(
  approval: Pick<PendingApproval, 'approver_rule' | 'approver_user_id' | 'agent_group_id'>,
): ApproverRule {
  if (approval.approver_rule === 'exclusive') {
    return { kind: 'exclusive', approverUserId: approval.approver_user_id };
  }
  return {
    kind: 'admins-of-scope',
    agentGroupId: approval.agent_group_id,
    deliveredTo: approval.approver_user_id,
  };
}
