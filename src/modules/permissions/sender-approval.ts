/**
 * Unknown-sender approval flow.
 *
 * When `messaging_groups.unknown_sender_policy = 'request_approval'` and a
 * non-member writes into a wired chat, the access gate drops the routing
 * attempt and calls `requestSenderApproval` to:
 *
 *   1. Pick an eligible approver (owner / admin of the agent group).
 *   2. Open / reuse a DM to that approver on a reachable channel.
 *   3. Deliver an Approve / Deny card.
 *   4. Record a pending_sender_approvals row that holds the original message
 *      so it can be re-routed on approve.
 *
 * On approve: the handler in index.ts adds an agent_group_members row for
 * the sender and re-invokes routeInbound with the stored event — the second
 * routing attempt passes the gate because the user is now a member.
 *
 * Failure modes (logged + row NOT created, so the dedup gate lets a future
 * attempt try again):
 *   - No eligible approver in user_roles — fresh install, no owner yet.
 *   - Approver has no reachable DM (no user_dms row + channel can't
 *     openDM) — e.g. owner hasn't registered on any channel we're wired to.
 *   - Delivery adapter missing.
 *
 * Dedup: `pending_sender_approvals` has UNIQUE(messaging_group_id,
 * sender_identity). A retry / rapid second message from the same unknown
 * sender is silently dropped (no duplicate card sent).
 *
 * This file also carries the `decline_notify` continuation: no
 * card, no buttons — a polite in-DM decline plus a one-line owner FYI,
 * deduped per (sender, messaging group) per 24h via a persisted decline
 * stamp reusing this table's UNIQUE key. See declineAndNotify at the bottom.
 */
import { normalizeOptions, type RawOption } from '../../channels/ask-question.js';
import { getAllAgentGroups } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { InboundEvent } from '../../channels/adapter.js';
import { pickApprovalDelivery, pickApprover } from '../approvals/primitive.js';
import {
  clearDeclineStamp,
  createPendingSenderApproval,
  getDeclineStampAt,
  hasInFlightSenderApproval,
  upsertDeclineStamp,
} from './db/pending-sender-approvals.js';
import { getOwners } from './db/user-roles.js';
import { getUser } from './db/users.js';
import { AGENT_ACCESS_SCOPE_WARNING } from './channel-approval.js';

const APPROVAL_OPTIONS: RawOption[] = [
  { label: 'Allow', selectedLabel: '✅ Allowed', value: 'approve', style: 'primary' },
  { label: 'Deny', selectedLabel: '❌ Denied', value: 'reject', style: 'danger' },
];

function generateId(): string {
  return `nsa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

  // A stale decline stamp (mg was decline_notify before flipping back to
  // request_approval) occupies the UNIQUE(messaging_group_id, sender_identity)
  // key this flow needs — clear it so the in-flight check and the row insert
  // see a clean slate.
  await clearDeclineStamp(messagingGroupId, senderIdentity);

  // In-flight dedup: don't spam the admin if the same unknown sender
  // retries while a card is already pending.
  if (await hasInFlightSenderApproval(messagingGroupId, senderIdentity)) {
    log.debug('Unknown-sender approval already in flight — dropping retry', {
      messagingGroupId,
      senderIdentity,
    });
    return;
  }

  const approvers = await pickApprover(agentGroupId);
  if (approvers.length === 0) {
    log.warn('Unknown-sender approval skipped — no owner or admin configured', {
      messagingGroupId,
      agentGroupId,
      senderIdentity,
    });
    return;
  }

  const originMg = await getMessagingGroup(messagingGroupId);
  const originChannelType = originMg?.channel_type ?? '';
  const target = await pickApprovalDelivery(approvers, originChannelType);
  if (!target) {
    log.warn('Unknown-sender approval skipped — no DM channel for any approver', {
      messagingGroupId,
      agentGroupId,
      senderIdentity,
    });
    return;
  }

  const approvalId = generateId();
  const senderDisplay = senderName && senderName.length > 0 ? senderName : senderIdentity;
  const originName = originMg?.name ?? `a ${originChannelType} channel`;

  const title = '👤 New sender';
  const question = `${senderDisplay} wants to talk to your agent in ${originName}. ${AGENT_ACCESS_SCOPE_WARNING} Allow?`;
  const options = normalizeOptions(APPROVAL_OPTIONS);

  await createPendingSenderApproval({
    id: approvalId,
    messaging_group_id: messagingGroupId,
    agent_group_id: agentGroupId,
    sender_identity: senderIdentity,
    sender_name: senderName,
    original_message: JSON.stringify(event),
    approver_user_id: target.userId,
    created_at: new Date().toISOString(),
    title,
    question,
    options_json: JSON.stringify(options),
  });

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    // Without a delivery adapter, the card can't be sent. Log + leave the
    // row in place so the admin can see it via DB or manual tooling; the
    // dedup gate will suppress further cards until it's cleared.
    log.error('Unknown-sender approval row created but no delivery adapter is wired', {
      approvalId,
    });
    return;
  }

  try {
    await adapter.deliver(
      target.messagingGroup.channel_type,
      target.messagingGroup.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({
        type: 'ask_question',
        questionId: approvalId,
        title,
        question,
        options,
      }),
    );
    log.info('Unknown-sender approval card delivered', {
      approvalId,
      senderIdentity,
      approver: target.userId,
      messagingGroupId,
      agentGroupId,
    });
  } catch (err) {
    log.error('Unknown-sender approval card delivery failed', {
      approvalId,
      err,
    });
  }
}

/**
 * Option value the admin clicked that means "allow" — shared with the
 * response handler so the two sides can't drift.
 */
export const APPROVE_VALUE = 'approve';
export const REJECT_VALUE = 'reject';

// ── Decline-and-notify (unknown_sender_policy = 'decline_notify') ──

/** At most one decline + one FYI per (sender, messaging group) per this window. */
export const DECLINE_NOTIFY_DEDUPE_MS = 24 * 60 * 60 * 1000;

/** Stamp key for a sender the resolver couldn't identify — the messaging
 *  group (a 1:1 DM) still keys the pair, so dedupe holds. */
const UNKNOWN_SENDER_KEY = 'unknown';

/** First owner with a display_name, for the decline copy. */
async function ownerDisplayName(): Promise<string | null> {
  for (const owner of await getOwners()) {
    const name = (await getUser(owner.user_id))?.display_name;
    if (name && name.length > 0) return name;
  }
  return null;
}

export interface DeclineAndNotifyInput {
  messagingGroupId: string;
  /** Approver-resolution anchor; null falls back to global admins/owners. */
  agentGroupId: string | null;
  senderIdentity: string | null; // namespaced user id, when resolvable
  senderName: string | null;
  event: InboundEvent;
  /** Override when the decline is scoped to the conversation, not the sender. */
  dedupeKey?: string;
  /** Override the sender-facing decline copy. */
  declineText?: string;
  /** Override the owner-facing FYI copy. */
  fyiText?: string;
}

/**
 * The decline_notify continuation: (a) a short polite decline sent as the
 * bot into the sender's DM, (b) a one-line informational FYI to the owner's
 * DM — plain text, NOT an approval card, no buttons. Grants stay explicit
 * (`ncl members add` / a future allow affordance). Callers record the
 * dropped message; dedupe is self-contained here — a persisted decline
 * stamp (pending_sender_approvals shape) suppresses repeats for 24h.
 */
export async function declineAndNotify(input: DeclineAndNotifyInput): Promise<void> {
  const { messagingGroupId, agentGroupId, senderIdentity, senderName, event } = input;

  // Dedupe: at most one decline + FYI per (sender, messaging group) per 24h.
  const senderKey = input.dedupeKey ?? senderIdentity ?? UNKNOWN_SENDER_KEY;
  const stampedAt = await getDeclineStampAt(messagingGroupId, senderKey);
  if (stampedAt && Date.now() - new Date(stampedAt).getTime() < DECLINE_NOTIFY_DEDUPE_MS) {
    log.debug('decline_notify deduped — declined within the last 24h', { messagingGroupId, senderIdentity });
    return;
  }

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.error('decline_notify skipped — no delivery adapter is wired', { messagingGroupId });
    return;
  }

  // Persist the stamp before sending: a delivery hiccup must not turn into a
  // decline storm on the sender's next message. FK needs a real agent group —
  // fall back to the first one (same reference-group pattern as the channel
  // card flow); with zero agent groups the stamp is skipped (no dedupe, rare
  // bootstrap state) but the decline still goes out.
  const stampAgentGroupId = agentGroupId ?? (await getAllAgentGroups())[0]?.id;
  if (stampAgentGroupId) {
    await upsertDeclineStamp({
      messaging_group_id: messagingGroupId,
      agent_group_id: stampAgentGroupId,
      sender_identity: senderKey,
      sender_name: senderName,
      original_message: JSON.stringify(event),
    });
  } else {
    log.debug('decline_notify stamp skipped — no agent groups exist', { messagingGroupId });
  }

  const originMg = await getMessagingGroup(messagingGroupId);

  // (a) Polite decline in the sender's DM, as the bot. Instance-addressed so
  // a per-agent bot identity registered as its own adapter instance
  // answers as itself.
  const owner = await ownerDisplayName();
  const declineText = input.declineText ?? `I'm ${owner ?? 'my owner'}'s personal agent — I can't help you directly.`;
  try {
    await adapter.deliver(
      event.channelType,
      event.platformId,
      null,
      'chat-sdk',
      JSON.stringify({ text: declineText }),
      undefined,
      originMg?.instance ?? event.instance,
    );
  } catch (err) {
    log.warn('decline_notify: decline delivery failed', { messagingGroupId, err });
  }

  // (b) Owner FYI — informational one-liner through the same approver-DM
  // resolution the card flows use.
  const approvers = await pickApprover(agentGroupId);
  if (approvers.length === 0) {
    log.warn('decline_notify FYI skipped — no owner or admin configured', { messagingGroupId, senderIdentity });
    return;
  }
  const target = await pickApprovalDelivery(approvers, event.channelType);
  if (!target) {
    log.warn('decline_notify FYI skipped — no DM channel for any approver', { messagingGroupId, senderIdentity });
    return;
  }

  const senderDisplay = senderName && senderName.length > 0 ? senderName : (senderIdentity ?? 'An unknown sender');
  const who =
    senderIdentity && senderDisplay !== senderIdentity ? `${senderDisplay} (${senderIdentity})` : senderDisplay;
  const fyiText =
    input.fyiText ??
    `FYI: ${who} DMed your agent on ${event.channelType} — I sent a polite decline. Allow them any time with \`ncl members add\`.`;
  try {
    await adapter.deliver(
      target.messagingGroup.channel_type,
      target.messagingGroup.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({ text: fyiText }),
    );
    log.info('decline_notify handled — decline sent, owner notified', {
      messagingGroupId,
      senderIdentity,
      notified: target.userId,
    });
  } catch (err) {
    log.error('decline_notify: owner FYI delivery failed', { messagingGroupId, err });
  }
}
