/**
 * Permissions guard adapter — the module's catalog entries, composed at the
 * module edge (imported by ./index.ts).
 *
 * senders.admit — the `unknown_sender_policy` switch moved verbatim out of
 * handleUnknownSender: `public` allows (short-circuited before the gate
 * anyway), `request_approval` holds, `strict` denies. The hold is executed by
 * the caller through the module's own pending_sender_approvals flow (card,
 * in-flight dedup) — not the approvals primitive — so this entry has no
 * grantActionName: the approve continuation adds the member and replays
 * routeInbound, which then passes the gate structurally via membership, no
 * grant needed.
 *
 * channels.register — click authorization for the channel-registration flow,
 * verbatim from today's response handler: the delivered approver, or an
 * admin of the pending row's anchor agent group. Consulted inline by the
 * card-click response handler only. The free-text name reply is deliberately
 * NOT re-authorized (main's behavior): the click arms the capture and stands
 * as the auth — a privilege revoked between the click and the reply still
 * completes the flow.
 */
import { ALLOW, DENY, HOLD, defineGuardedAction } from '../../guard/index.js';
import { getPendingChannelApproval } from './db/pending-channel-approvals.js';
import { hasAdminPrivilege } from './db/user-roles.js';

export const sendersAdmit = defineGuardedAction({
  action: 'senders.admit',
  decide: (input) => {
    const policy = input.payload.policy;
    if (policy === 'public') return ALLOW('public messaging group');
    if (policy === 'request_approval') {
      return HOLD(
        `unknown sender requires admin approval on messaging group ${String(input.payload.messagingGroupId)}`,
      );
    }
    return DENY('unknown sender on a strict messaging group');
  },
});

export const channelsRegister = defineGuardedAction({
  action: 'channels.register',
  decide: (input) => {
    if (input.actor.kind !== 'human') return DENY('channel registration resolves via human clicks/replies');
    const questionId = typeof input.payload.questionId === 'string' ? input.payload.questionId : '';
    const row = getPendingChannelApproval(questionId);
    if (!row) return DENY(`no pending channel registration for ${questionId || '(missing questionId)'}`);
    if (
      input.actor.userId &&
      (input.actor.userId === row.approver_user_id || hasAdminPrivilege(input.actor.userId, row.agent_group_id))
    ) {
      return ALLOW('delivered approver or anchor-group admin');
    }
    return DENY('not an eligible channel-registration approver');
  },
});
