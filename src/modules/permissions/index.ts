/**
 * Permissions module — sender resolution + access gate.
 *
 * Registers two hooks into the core router:
 *   1. setSenderResolver — runs before agent resolution. Parses the payload,
 *      derives a namespaced user id, and upserts the `users` row on first
 *      sight. Returns null when the payload doesn't carry enough to identify
 *      a sender.
 *   2. setAccessGate — runs after agent resolution. Enforces the
 *      unknown_sender_policy (strict/request_approval/decline_notify/public) and the
 *      owner/global-admin/scoped-admin/member access hierarchy. Records its
 *      own `dropped_messages` row on refusal (structural drops are recorded
 *      by core).
 *
 * Without this module: sender resolution is a no-op (userId=null); the
 * access gate is not registered and core defaults to allow-all.
 */
import { recordDroppedMessage } from '../../db/dropped-messages.js';
import { getAgentGroup, getAllAgentGroups } from '../../db/agent-groups.js';
import { createMessagingGroupAgent, getMessagingGroup, setMessagingGroupDeniedAt } from '../../db/messaging-groups.js';
import { resolveWiringDefaults } from '../../channels/channel-defaults.js';
import {
  routeInbound,
  setAccessGate,
  setChannelRequestGate,
  registerMessageInterceptor,
  setSenderResolver,
  setSenderScopeGate,
  type AccessGateResult,
} from '../../router.js';
import type { InboundEvent } from '../../channels/adapter.js';
import { getDb } from '../../db/connection.js';
import { registerResponseHandler, type ResponseOutcome, type ResponsePayload } from '../../response-registry.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { MessagingGroup, MessagingGroupAgent } from '../../types.js';
import { guard } from '../../guard/index.js';
import { channelsRegister, sendersAdmit } from './guard.js';
import { canAccessAgentGroup } from './access.js';
import {
  AGENT_ACCESS_SCOPE_WARNING,
  buildAgentSelectionOptions,
  CHOOSE_EXISTING_VALUE,
  CONNECT_PREFIX,
  createNewAgentGroup,
  NEW_AGENT_VALUE,
  REJECT_VALUE,
  requestChannelApproval,
  recordChannelApprovalCard,
  isCurrentChannelApprovalCard,
} from './channel-approval.js';
import { addMember } from './db/agent-group-members.js';
import {
  deletePendingChannelApproval,
  getPendingChannelApproval,
  updatePendingChannelApprovalCard,
  type PendingChannelApproval,
} from './db/pending-channel-approvals.js';
import { deletePendingSenderApproval, getPendingSenderApproval } from './db/pending-sender-approvals.js';
import { hasAdminPrivilege } from './db/user-roles.js';
import { getUser, upsertUser } from './db/users.js';
import { declineAndNotify, requestSenderApproval } from './sender-approval.js';
import { ensureUserDm } from './user-dm.js';

// ── Free-text name input state ──
// Tracks approvers waiting for a text reply with the agent name. Keyed by
// namespaced userId (e.g. "slack:U0ABC"). Cleared on receipt or restart.
interface PendingNameInput {
  channelMgId: string;
  dmChannelType: string;
  dmPlatformId: string;
  dmInstance: string;
}
const awaitingNameInput = new Map<string, PendingNameInput>();

// ── Agent card replacing the first card ──
// Card buttons are decoded by position against the stored options, and the
// first card keeps its buttons until the host accepts. So while an agent card
// is sent no card click counts, once it is out the card clicked for it is
// ignored, and an agent card whose options weren't stored is ignored for good
// (if its id is unknown, that request is blocked; replacements require a known card).
// Keyed by messaging group, in memory alongside the delivery receipts.
const agentCards = new Map<string, { retired: Set<string>; sending: boolean; blocked?: string }>();

async function extractAndUpsertUser(event: InboundEvent): Promise<string | null> {
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(event.message.content) as Record<string, unknown>;
  } catch {
    return null;
  }

  // chat-sdk-bridge serializes author info as a nested `author.userId` and
  // does NOT populate top-level `senderId`. Older adapters (v1, native) put
  // `senderId` or `sender` directly at the top level. Check all three.
  const senderIdField = typeof content.senderId === 'string' ? content.senderId : undefined;
  const senderField = typeof content.sender === 'string' ? content.sender : undefined;
  const author =
    typeof content.author === 'object' && content.author !== null
      ? (content.author as Record<string, unknown>)
      : undefined;
  const authorUserId = typeof author?.userId === 'string' ? (author.userId as string) : undefined;
  const senderName =
    (typeof content.senderName === 'string' ? content.senderName : undefined) ??
    (typeof author?.fullName === 'string' ? (author.fullName as string) : undefined) ??
    (typeof author?.userName === 'string' ? (author.userName as string) : undefined);

  const rawHandle = senderIdField ?? senderField ?? authorUserId;
  if (!rawHandle) return null;

  const userId = rawHandle.includes(':') ? rawHandle : `${event.channelType}:${rawHandle}`;
  if (!(await getUser(userId))) {
    await upsertUser({
      id: userId,
      kind: event.channelType,
      display_name: senderName ?? null,
      created_at: new Date().toISOString(),
    });
  }
  return userId;
}

function safeParseContent(raw: string): { text?: string; sender?: string; senderId?: string } {
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}

async function handleUnknownSender(
  mg: MessagingGroup,
  userId: string | null,
  agentGroupId: string,
  accessReason: string,
  event: InboundEvent,
): Promise<void> {
  const parsed = safeParseContent(event.message.content);
  const senderName = parsed.sender ?? null;
  const dropRecord = {
    channel_type: event.channelType,
    platform_id: event.platformId,
    user_id: userId,
    sender_name: senderName,
    reason: `unknown_sender_${mg.unknown_sender_policy}`,
    messaging_group_id: mg.id,
    agent_group_id: agentGroupId,
  };

  // The admission decision is the guard's senders.admit decision (./guard.ts)
  // — unknown_sender_policy verbatim: strict → deny, request_approval → hold,
  // public → allow (short-circuited before the gate). Drop-recording and the
  // hold creation stay here.
  const decision = await guard(sendersAdmit, {
    actor: userId ? { kind: 'human', userId } : { kind: 'system' },
    payload: {
      messagingGroupId: mg.id,
      agentGroupId,
      senderIdentity: userId,
      policy: mg.unknown_sender_policy,
    },
  });

  if (decision.effect === 'allow') return; // 'public' — handled before the gate; fall through silently.

  const isDeclineNotify = mg.unknown_sender_policy === 'decline_notify';

  log.info(
    isDeclineNotify
      ? 'MESSAGE DROPPED — unknown sender (decline-and-notify policy)'
      : decision.effect === 'hold'
        ? 'MESSAGE DROPPED — unknown sender (approval requested)'
        : 'MESSAGE DROPPED — unknown sender (strict policy)',
    {
      messagingGroupId: mg.id,
      agentGroupId,
      userId,
      accessReason,
    },
  );
  await recordDroppedMessage(dropRecord);

  // decline_notify: polite in-DM decline + one-line owner FYI, no
  // card. Fire-and-forget like the hold path — declineAndNotify dedupes
  // itself (24h stamp) and logs failures internally; the sender's message
  // stays dropped either way.
  if (isDeclineNotify) {
    // The decline copy assumes a 1:1 DM surface. The policy is
    // settable on groups (ncl / setup register), where delivering it would
    // post the decline publicly into the channel — treat groups as strict:
    // the drop above stands, nothing is sent.
    if (mg.is_group === 1) {
      log.warn('decline_notify on a group messaging group — treated as strict (no public decline)', {
        messagingGroupId: mg.id,
      });
      return;
    }
    declineAndNotify({
      messagingGroupId: mg.id,
      agentGroupId,
      senderIdentity: userId,
      senderName,
      event,
    }).catch((err) => log.error('decline_notify flow threw', { err }));
    return;
  }

  // Fire-and-forget; pick-approver + delivery + row-insert are all async.
  // If it fails it logs internally — the user's message still stays dropped
  // either way. Requires a resolved userId (senderResolver populates users
  // row before the gate fires); if we got here without one, there's nothing
  // to identify for approval and we just drop silently.
  if (decision.effect === 'hold' && userId) {
    requestSenderApproval({
      messagingGroupId: mg.id,
      agentGroupId,
      senderIdentity: userId,
      senderName,
      event,
    }).catch((err) => log.error('Sender-approval flow threw', { err }));
  }
}

setSenderResolver(extractAndUpsertUser);

setAccessGate(async (event, userId, mg, agentGroupId): Promise<AccessGateResult> => {
  // Public channels skip the access check entirely.
  if (mg.unknown_sender_policy === 'public') {
    return { allowed: true };
  }

  if (!userId) {
    await handleUnknownSender(mg, null, agentGroupId, 'unknown_user', event);
    return { allowed: false, reason: 'unknown_user' };
  }

  const decision = await canAccessAgentGroup(userId, agentGroupId);
  if (decision.allowed) {
    return { allowed: true };
  }

  await handleUnknownSender(mg, userId, agentGroupId, decision.reason, event);
  return { allowed: false, reason: decision.reason };
});

/**
 * Per-wiring sender-scope enforcement. Stricter than the messaging-group
 * `unknown_sender_policy` — a wiring can require `sender_scope='known'`
 * (explicit owner / admin / member) even on a 'public' messaging group.
 *
 * 'all' is a no-op; any sender passes. 'known' requires a userId that
 * canAccessAgentGroup accepts (owner, admin, or group member).
 */
setSenderScopeGate(
  async (
    _event: InboundEvent,
    userId: string | null,
    _mg: MessagingGroup,
    agent: MessagingGroupAgent,
  ): Promise<AccessGateResult> => {
    if (agent.sender_scope === 'all') return { allowed: true };
    if (!userId) return { allowed: false, reason: 'unknown_user_scope' };
    const decision = await canAccessAgentGroup(userId, agent.agent_group_id);
    if (decision.allowed) return { allowed: true };
    return { allowed: false, reason: `sender_scope_${decision.reason}` };
  },
);

/**
 * Response handler for the unknown-sender approval card.
 *
 * Claim rule: questionId matches a row in pending_sender_approvals. If no
 * such row, return false so the next handler (approvals module, gateway,
 * interactive) gets a shot.
 *
 * Approve: add the sender to agent_group_members + re-invoke routeInbound
 * with the stored event. The second routing attempt clears the gate because
 * the user is now a member.
 *
 * Deny: delete the row (no "deny list" — a future message re-triggers a
 * fresh card per ACTION-ITEMS item 5 "no denial persistence").
 */
async function handleSenderApprovalResponse(payload: ResponsePayload): Promise<ResponseOutcome | false> {
  const row = await getPendingSenderApproval(payload.questionId);
  if (!row) return false;

  // payload.userId is the raw platform userId (e.g. "6037840640"); namespace it
  // with the channel type so it matches users(id) format. Some platforms
  // (e.g. Teams "29:xxx") already include a colon — mirror resolveOrCreateUser
  // logic and only prefix when the raw id has no colon.
  const clickerId = payload.userId
    ? payload.userId.includes(':')
      ? payload.userId
      : `${payload.channelType}:${payload.userId}`
    : null;
  const isAuthorized =
    clickerId !== null &&
    (clickerId === row.approver_user_id || (await hasAdminPrivilege(clickerId, row.agent_group_id)));
  if (!isAuthorized) {
    log.warn('Unknown-sender approval click rejected — unauthorized clicker', {
      approvalId: row.id,
      clickerId,
      expectedApprover: row.approver_user_id,
    });
    return 'refused'; // the card keeps its buttons for a real approver
  }
  const approverId = clickerId;
  const approved = payload.value === 'approve';

  // Deleting the row claims the decision: of two responses, only one proceeds.
  // One transaction with the member insert, so a failed insert keeps the request.
  // It also clears the row BEFORE re-routing, so the gate check on the second
  // attempt doesn't see the in-flight row and short-circuit.
  const claimed = await getDb().transaction(async () => {
    if (!(await deletePendingSenderApproval(row.id))) return false;
    if (approved) {
      await addMember({
        user_id: row.sender_identity,
        agent_group_id: row.agent_group_id,
        added_by: approverId,
        added_at: new Date().toISOString(),
      });
    }
    return true;
  });
  if (!claimed) return 'ignored';
  // Recorded: the card can show it while the held message is replayed.
  payload.accepted?.();

  if (approved) {
    log.info('Unknown sender approved — member added', {
      approvalId: row.id,
      senderIdentity: row.sender_identity,
      agentGroupId: row.agent_group_id,
      approverId,
    });

    try {
      const event = JSON.parse(row.original_message) as InboundEvent;
      await routeInbound(event);
    } catch (err) {
      log.error('Failed to replay message after sender approval', { approvalId: row.id, err });
    }
    return 'accepted';
  }

  log.info('Unknown sender denied', {
    approvalId: row.id,
    senderIdentity: row.sender_identity,
    agentGroupId: row.agent_group_id,
    approverId,
  });
  return 'accepted';
}

registerResponseHandler(handleSenderApprovalResponse);

// ── Unknown-channel registration flow ──

setChannelRequestGate(async (mg, event) => {
  await requestChannelApproval({ messagingGroupId: mg.id, event });
});

/**
 * Wire an approved channel to an agent group and replay the stored event.
 * Shared by both approve paths (connect-existing button, free-text new-agent
 * name reply) so they produce identical wirings. Returns 'accepted' when this
 * call claimed the request and created the wiring, 'ignored' when another
 * response claimed it first, 'closed' when the request had to be dropped;
 * callers must not confirm success to the approver unless 'accepted'.
 *
 * Engage defaults come from the channel's declared defaults (DM vs group
 * context). isGroup uses the adapter's own flag with the persisted row as
 * fallback — never `threadId !== null` (DM sub-threads exist on Slack/Discord;
 * non-threaded group platforms like WhatsApp have null threadIds in groups).
 */
async function wireApprovedChannel(
  row: PendingChannelApproval,
  agentGroupId: string,
  approverId: string,
  accepted?: () => void,
): Promise<ResponseOutcome> {
  let event: InboundEvent;
  try {
    event = JSON.parse(row.original_message) as InboundEvent;
  } catch (err) {
    log.error('Channel registration: failed to parse stored event', {
      messagingGroupId: row.messaging_group_id,
      err,
    });
    await deletePendingChannelApproval(row.messaging_group_id);
    return 'closed';
  }

  const mg = await getMessagingGroup(row.messaging_group_id);
  const isGroup = event.message.isGroup ?? mg?.is_group === 1;
  const agentGroupName = (await getAgentGroup(agentGroupId))?.name ?? '';

  let engage: { engage_mode: MessagingGroupAgent['engage_mode']; engage_pattern: string | null };
  try {
    engage = resolveWiringDefaults(
      mg?.instance ?? mg?.channel_type ?? event.channelType,
      isGroup,
      agentGroupName,
      mg?.channel_type ?? event.channelType,
    );
  } catch (err) {
    // Mis-declared adapter (pattern mode without a pattern). Drop the pending
    // row so a future mention can retry once the declaration is fixed.
    log.error('Channel registration: channel defaults unresolvable', {
      messagingGroupId: row.messaging_group_id,
      err,
    });
    await deletePendingChannelApproval(row.messaging_group_id);
    return 'closed';
  }

  const mgaId = `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Deleting the row claims the choice: of two, only one wires the channel. One
  // transaction with the wiring, so a failed write keeps the request.
  const claimed = await getDb().transaction(async () => {
    if (!(await deletePendingChannelApproval(row.messaging_group_id))) return false;
    await createMessagingGroupAgent({
      id: mgaId,
      messaging_group_id: row.messaging_group_id,
      agent_group_id: agentGroupId,
      engage_mode: engage.engage_mode,
      engage_pattern: engage.engage_pattern,
      // Deliberate card-flow choices, not channel defaults: the triggering
      // sender is auto-admitted below, so 'known' keeps other strangers gated;
      // 'accumulate' / 'shared' / priority 0 are the flow's fixed semantics.
      sender_scope: 'known',
      ignored_message_policy: 'accumulate',
      session_mode: 'shared',
      priority: 0,
      created_at: new Date().toISOString(),
    });
    const senderUserId = await extractAndUpsertUser(event);
    if (senderUserId) {
      await addMember({
        user_id: senderUserId,
        agent_group_id: agentGroupId,
        added_by: approverId,
        added_at: new Date().toISOString(),
      });
    }
    return true;
  });
  if (!claimed) return 'ignored';
  // Recorded: the card can show it while the message is replayed.
  accepted?.();
  log.info('Channel registration approved — wiring created', {
    messagingGroupId: row.messaging_group_id,
    agentGroupId,
    mgaId,
    engageMode: engage.engage_mode,
    approverId,
  });

  try {
    await routeInbound(event);
  } catch (err) {
    log.error('Failed to replay message after channel approval', {
      messagingGroupId: row.messaging_group_id,
      err,
    });
  }
  return 'accepted';
}

/**
 * Sends the agent-selection card that replaces the clicked card (`sent` once it is out), then stores its
 * options. `unstored` gets the card's id when they weren't, and whether the first card's are still stored.
 */
async function sendAgentCard(
  row: PendingChannelApproval,
  payload: ResponsePayload,
  approverId: string,
  on: { sent: () => void; unstored: (cardId: string | undefined, firstCardStored: boolean) => void },
): Promise<ResponseOutcome> {
  const origin = await getMessagingGroup(row.messaging_group_id);
  const approverDm = await ensureUserDm(row.approver_user_id, {
    instance: payload.channelType === origin?.channel_type ? origin.instance : undefined,
  });
  if (!approverDm) {
    log.error('Channel registration: no DM channel for approver', {
      messagingGroupId: row.messaging_group_id,
      approverUserId: row.approver_user_id,
    });
    return 'ignored';
  }

  const adapter = getDeliveryAdapter();
  if (!adapter) return 'ignored';

  const agentGroups = await getAllAgentGroups();
  const options = await buildAgentSelectionOptions(agentGroups, approverId);
  const title = '📋 Choose an agent';
  const question = `Which agent should handle this channel? ${AGENT_ACCESS_SCOPE_WARNING}`;

  // Sent before its options are stored, so a send that fails leaves the first card as it was.
  let cardId: string | undefined;
  try {
    cardId = await adapter.deliver(
      approverDm.channel_type,
      approverDm.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({
        type: 'ask_question',
        questionId: row.messaging_group_id,
        title,
        question,
        options,
      }),
      undefined,
      approverDm.instance,
    );
  } catch (err) {
    log.error('Channel registration: agent-selection card delivery failed', {
      messagingGroupId: row.messaging_group_id,
      err,
    });
    return 'ignored'; // the first card keeps its buttons for another try
  }
  on.sent();
  // Decided meanwhile (a Reject), or a newer request: leave that card as it is.
  let stored: boolean;
  try {
    stored = await updatePendingChannelApprovalCard(
      row.messaging_group_id,
      row.created_at,
      title,
      question,
      JSON.stringify(options),
    );
  } catch (err) {
    log.error('Channel registration: agent-selection card options not stored', {
      messagingGroupId: row.messaging_group_id,
      err,
    });
    // The store may have failed after the row was replaced: check it is still this request.
    const current = await getPendingChannelApproval(row.messaging_group_id).catch(() => undefined);
    on.unstored(cardId, current?.created_at === row.created_at && current?.options_json === row.options_json);
    return 'ignored';
  }
  if (!stored) {
    on.unstored(cardId, false);
    return 'ignored';
  }
  recordChannelApprovalCard(row.messaging_group_id, row.created_at, cardId);
  return 'accepted';
}

/**
 * Response handler for the unknown-channel registration card.
 *
 * Claim rule: questionId matches a pending_channel_approvals row (keyed
 * by messaging_group_id). If no such row, return false so downstream
 * handlers get a shot.
 *
 * Value dispatch:
 *   connect:<id>    — wire to an existing agent group, replay the message
 *   choose_existing — send a follow-up card listing all agents
 *   new_agent       — prompt for a free-text agent name (interceptor
 *                     captures the reply and creates immediately)
 *   reject          — set denied_at, delete pending row
 */
async function handleChannelApprovalResponse(payload: ResponsePayload): Promise<ResponseOutcome | false> {
  const row = await getPendingChannelApproval(payload.questionId);
  if (!row) return false;

  // Click authorization is the guard's channels.register decision (./guard.ts):
  // the delivered approver, or an admin of the pending row's anchor agent group.
  const clickerId = payload.userId
    ? payload.userId.includes(':')
      ? payload.userId
      : `${payload.channelType}:${payload.userId}`
    : null;
  const decision = await guard(channelsRegister, {
    actor: { kind: 'human', userId: clickerId ?? '' },
    payload: { questionId: payload.questionId },
  });
  if (!clickerId || decision.effect !== 'allow') {
    log.warn('Channel registration click rejected — unauthorized clicker', {
      messagingGroupId: row.messaging_group_id,
      clickerId,
      expectedApprover: row.approver_user_id,
      reason: decision.reason,
    });
    return 'refused';
  }
  const approverId = clickerId;
  const swap = agentCards.get(row.messaging_group_id);
  // Never forget an unknown stale card just because the request was replaced.
  // A newer request recovers only through its positively identified current card.
  if (
    swap?.blocked &&
    (swap.blocked === row.created_at ||
      !isCurrentChannelApprovalCard(row.messaging_group_id, row.created_at, payload.messageId))
  )
    return 'ignored';
  if (swap && payload.messageId && (swap.sending || swap.retired.has(payload.messageId))) return 'ignored';

  // ── Reject / Cancel ──
  if (payload.value === REJECT_VALUE) {
    // Claimed like a connect: of a racing Reject and connect, only one decides.
    const claimed = await getDb().transaction(async () => {
      if (!(await deletePendingChannelApproval(row.messaging_group_id))) return false;
      await setMessagingGroupDeniedAt(row.messaging_group_id, new Date().toISOString());
      return true;
    });
    if (!claimed) return 'ignored';
    log.info('Channel registration denied', {
      messagingGroupId: row.messaging_group_id,
      approverId,
    });
    return 'accepted';
  }

  // ── Choose existing agent — send agent-selection follow-up card ──
  if (payload.value === CHOOSE_EXISTING_VALUE) {
    // Set before any wait, so a second tap can't start another, nor a typed answer (no card id).
    const guard = agentCards.get(row.messaging_group_id) ?? { retired: new Set<string>(), sending: false };
    if (guard.sending) return 'ignored';
    guard.sending = true;
    agentCards.set(row.messaging_group_id, guard);
    try {
      return await sendAgentCard(row, payload, approverId, {
        sent: () => {
          if (payload.messageId) guard.retired.add(payload.messageId);
        },
        // While the first card's options are still the stored ones it works again.
        unstored: (cardId, firstCardStored) => {
          if (!cardId) guard.blocked = row.created_at;
          else guard.retired.add(cardId);
          if (cardId && firstCardStored && payload.messageId) guard.retired.delete(payload.messageId);
        },
      });
    } finally {
      guard.sending = false;
      if (guard.retired.size === 0 && !guard.blocked && agentCards.get(row.messaging_group_id) === guard)
        agentCards.delete(row.messaging_group_id);
    }
  }

  // ── Create new agent — prompt for free-text name ──
  if (payload.value === NEW_AGENT_VALUE) {
    const origin = await getMessagingGroup(row.messaging_group_id);
    const approverDm = await ensureUserDm(row.approver_user_id, {
      instance: payload.channelType === origin?.channel_type ? origin.instance : undefined,
    });
    if (!approverDm) {
      log.error('Channel registration: no DM channel for approver', {
        messagingGroupId: row.messaging_group_id,
        approverUserId: row.approver_user_id,
      });
      return 'ignored';
    }

    const adapter = getDeliveryAdapter();
    if (!adapter) {
      log.error('Channel registration: no delivery adapter for name prompt', {
        messagingGroupId: row.messaging_group_id,
      });
      return 'ignored';
    }
    const prompt = {
      channelMgId: row.messaging_group_id,
      dmChannelType: approverDm.channel_type,
      dmPlatformId: approverDm.platform_id,
      dmInstance: approverDm.instance ?? approverDm.channel_type,
    };
    awaitingNameInput.set(row.approver_user_id, prompt);

    try {
      await adapter.deliver(
        approverDm.channel_type,
        approverDm.platform_id,
        null,
        'chat-sdk',
        JSON.stringify({ text: 'Reply with the name for your new agent:' }),
        undefined,
        approverDm.instance,
      );
    } catch (err) {
      log.error('Channel registration: name prompt delivery failed', {
        messagingGroupId: row.messaging_group_id,
        err,
      });
      // A newer prompt (a refused name's re-arm, or another channel's) may have replaced this one.
      if (awaitingNameInput.get(row.approver_user_id) === prompt) awaitingNameInput.delete(row.approver_user_id);
      return 'ignored';
    }
    return 'accepted';
  }

  // ── Resolve target agent group (connect to existing or create new) ──
  let targetAgentGroupId: string;

  if (payload.value.startsWith(CONNECT_PREFIX)) {
    targetAgentGroupId = payload.value.slice(CONNECT_PREFIX.length);
    const ag = await getAgentGroup(targetAgentGroupId);
    if (!ag) {
      log.error('Channel registration: target agent group no longer exists', {
        messagingGroupId: row.messaging_group_id,
        targetAgentGroupId,
      });
      return (await deletePendingChannelApproval(row.messaging_group_id)) ? 'closed' : 'ignored';
    }
    if (!(await hasAdminPrivilege(approverId, targetAgentGroupId))) {
      log.warn('Channel registration: target agent group rejected for unauthorized approver', {
        messagingGroupId: row.messaging_group_id,
        targetAgentGroupId,
        approverId,
      });
      return 'refused';
    }
  } else {
    log.warn('Channel registration: unknown response value', {
      messagingGroupId: row.messaging_group_id,
      value: payload.value,
    });
    return 'ignored';
  }

  // ── Wire + replay (shared path for connect and create) ──
  return wireApprovedChannel(row, targetAgentGroupId, approverId, payload.accepted);
}

registerResponseHandler(handleChannelApprovalResponse);

// ── Free-text name interceptor ──
// Captures the next DM from an approver who clicked "Create new agent",
// creates the agent immediately, wires the channel, and replays.

registerMessageInterceptor(async (event: InboundEvent): Promise<boolean> => {
  const userId = await extractAndUpsertUser(event);
  if (!userId) return false;

  const pending = awaitingNameInput.get(userId);
  if (!pending) return false;
  if (event.channelType !== pending.dmChannelType || event.platformId !== pending.dmPlatformId) return false;
  if ((event.instance ?? event.channelType) !== pending.dmInstance) return false;

  awaitingNameInput.delete(userId);

  let text: string | undefined;
  try {
    const parsed = JSON.parse(event.message.content) as Record<string, unknown>;
    text = (typeof parsed.text === 'string' ? parsed.text : undefined)?.trim();
  } catch {
    /* fall through */
  }

  if (!text) {
    log.warn('Channel registration: empty name reply, ignoring', { userId });
    return true;
  }

  const row = await getPendingChannelApproval(pending.channelMgId);
  if (!row) return true;

  const created = await createNewAgentGroup(text);
  if (typeof created === 'string') {
    const adapter = getDeliveryAdapter();
    if (!adapter) return true;
    // Nothing was written; re-arm so the approver's next reply is the name, unless they opened
    // another channel's prompt meanwhile. A fresh object, so only this re-arm's failure can drop it.
    const rearmed = awaitingNameInput.has(userId) ? undefined : { ...pending };
    if (rearmed) awaitingNameInput.set(userId, rearmed);
    try {
      await adapter.deliver(
        event.channelType,
        event.platformId,
        null,
        'chat-sdk',
        JSON.stringify({
          text: `⚠️ Cannot create agent "${text}": ${created}. Nothing was created.${rearmed ? ' Reply with another name:' : ''}`,
        }),
        undefined,
        event.instance,
      );
    } catch (err) {
      log.error('Channel registration: name re-prompt delivery failed', {
        messagingGroupId: row.messaging_group_id,
        err,
      });
      // A newer prompt may have replaced ours while this was in flight.
      if (awaitingNameInput.get(userId) === rearmed) awaitingNameInput.delete(userId);
    }
    return true;
  }
  const ag = created;
  log.info('Channel registration: new agent group created', {
    messagingGroupId: row.messaging_group_id,
    agentGroupId: ag.id,
    agentName: ag.name,
    folder: ag.folder,
  });

  const wired = await wireApprovedChannel(row, ag.id, userId);

  const adapter = getDeliveryAdapter();
  if (adapter) {
    adapter
      .deliver(
        event.channelType,
        event.platformId,
        null,
        'chat-sdk',
        JSON.stringify({
          text:
            wired === 'accepted'
              ? `✅ Agent "${ag.name}" created and connected.`
              : `⚠️ Agent "${ag.name}" was created but the channel couldn't be connected — check the host logs.`,
        }),
        undefined,
        event.instance,
      )
      .catch(() => {});
  }
  return true;
});
