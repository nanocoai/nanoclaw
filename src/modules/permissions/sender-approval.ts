/**
 * Unknown-sender approval flow.
 *
 * When `messaging_groups.unknown_sender_policy = 'request_approval'` and a
 * non-member writes into a wired chat, the access gate drops the routing
 * attempt and calls `requestSenderApproval`, which holds through the
 * approvals primitive (action 'sender_admit'):
 *
 *   - approver rule: the agent group's admin chain, plus the specific
 *     admin the card was delivered to (named-or-admin);
 *   - in-flight dedup via the hold's dedup key — a retry / rapid second
 *     message from the same unknown sender is silently dropped (no duplicate
 *     card), replacing the old sender table's UNIQUE(mg, sender);
 *   - the hold is sessionless: there is no agent session to notify, so
 *     failure modes (no approver, no reachable DM, no adapter) log and leave
 *     no row, letting a future attempt retry.
 *   - sender-specific query/continuation fields live in a one-to-one detail
 *     row created atomically with the common lifecycle master.
 *
 * On approve: `registerSenderApprovalContinuation` adds an agent-group member
 * row for the sender and replays the stored event through the router callback
 * supplied by the permissions module — the second routing attempt passes the
 * gate because the user is now a member. On deny: the shared reject path just
 * drops the hold (no denial persistence — a future message re-triggers a fresh
 * card).
 */
import type { RawOption } from '../../channels/ask-question.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { deletePendingApproval, getPendingApprovalByDedupKey } from '../../db/sessions.js';
import type { InboundEvent } from '../../channels/adapter.js';
import { log } from '../../log.js';
import { registerApprovalHandler, requestApproval } from '../approvals/primitive.js';
import { addMember } from './db/agent-group-members.js';
import {
  createPendingSenderApprovalDetail,
  getPendingSenderApprovalDetail,
} from './db/pending-sender-approval-details.js';

const APPROVAL_OPTIONS: RawOption[] = [
  { label: 'Allow', selectedLabel: '✅ Allowed', value: 'approve', style: 'primary' },
  { label: 'Deny', selectedLabel: '❌ Denied', value: 'reject', style: 'danger' },
];

export const SENDER_ADMIT_ACTION = 'sender_admit';

export function senderAdmitDedupKey(messagingGroupId: string, senderIdentity: string): string {
  return `${SENDER_ADMIT_ACTION}:${messagingGroupId}:${senderIdentity}`;
}

export interface RequestSenderApprovalInput {
  messagingGroupId: string;
  agentGroupId: string;
  senderIdentity: string; // namespaced user id (channel_type:handle)
  senderName: string | null;
  event: InboundEvent;
}

export async function requestSenderApproval(input: RequestSenderApprovalInput): Promise<void> {
  const { messagingGroupId, agentGroupId, senderIdentity, senderName, event } = input;

  const originMg = getMessagingGroup(messagingGroupId);
  const senderDisplay = senderName && senderName.length > 0 ? senderName : senderIdentity;
  const originName = originMg?.name ?? `a ${originMg?.channel_type ?? ''} channel`;

  await requestApproval({
    agentGroupId,
    agentName: senderDisplay,
    action: SENDER_ADMIT_ACTION,
    payload: { messagingGroupId, agentGroupId, senderIdentity, senderName, event },
    title: '👤 New sender',
    question: `${senderDisplay} wants to talk to your agent in ${originName}. Allow?`,
    options: APPROVAL_OPTIONS,
    dedupKey: senderAdmitDedupKey(messagingGroupId, senderIdentity),
    recordDeliveredApprover: true,
    originChannelType: originMg?.channel_type ?? '',
    persistDetails: (approvalId) =>
      createPendingSenderApprovalDetail({
        approval_id: approvalId,
        messaging_group_id: messagingGroupId,
        sender_identity: senderIdentity,
        sender_name: senderName,
        original_message: JSON.stringify(event),
      }),
  });
}

/**
 * Register the approve continuation for sessionless sender-admission holds.
 * The router callback is injected by permissions/index.ts so this focused
 * module owns the domain flow without importing the router back through the
 * permissions module's registration cycle.
 */
export function registerSenderApprovalContinuation(replayInbound: (event: InboundEvent) => Promise<void>): void {
  registerApprovalHandler(SENDER_ADMIT_ACTION, async ({ approval, userId }) => {
    const detail = getPendingSenderApprovalDetail(approval.approval_id);
    const agentGroupId = approval.agent_group_id ?? '';
    if (!detail || !agentGroupId) {
      log.warn('sender_admit approved but its master/detail record was incomplete', {
        approvalId: approval.approval_id,
        hasDetail: detail !== undefined,
        agentGroupId,
      });
      return;
    }

    const { sender_identity: senderIdentity, messaging_group_id: messagingGroupId } = detail;
    let parsedEvent: unknown;
    try {
      parsedEvent = JSON.parse(detail.original_message);
    } catch (err) {
      log.warn('sender_admit approved but its stored event was malformed', {
        approvalId: approval.approval_id,
        senderIdentity,
        agentGroupId,
        err,
      });
      return;
    }
    if (!isInboundEvent(parsedEvent)) {
      log.warn('sender_admit approved but its stored event had an invalid shape', {
        approvalId: approval.approval_id,
        senderIdentity,
        agentGroupId,
      });
      return;
    }

    addMember({
      user_id: senderIdentity,
      agent_group_id: agentGroupId,
      added_by: userId,
      added_at: new Date().toISOString(),
    });
    log.info('Unknown sender approved — member added', { senderIdentity, agentGroupId, approverId: userId });

    // Clear the hold before replaying. A messaging group may fan out to other
    // agent groups, which must be free to create their own sender-admission hold
    // instead of being suppressed by this resolved hold's dedup key.
    const hold = getPendingApprovalByDedupKey(senderAdmitDedupKey(messagingGroupId, senderIdentity));
    if (hold) deletePendingApproval(hold.approval_id);

    try {
      await replayInbound(parsedEvent);
    } catch (err) {
      log.error('Failed to replay message after sender approval', { senderIdentity, agentGroupId, err });
    }
  });
}

function isInboundEvent(value: unknown): value is InboundEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;
  if (
    typeof event.channelType !== 'string' ||
    typeof event.platformId !== 'string' ||
    (event.threadId !== null && typeof event.threadId !== 'string') ||
    typeof event.message !== 'object' ||
    event.message === null
  ) {
    return false;
  }
  const message = event.message as Record<string, unknown>;
  return (
    typeof message.id === 'string' &&
    (message.kind === 'chat' || message.kind === 'chat-sdk') &&
    typeof message.content === 'string' &&
    typeof message.timestamp === 'string'
  );
}
