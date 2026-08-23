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
import { registerResponseHandler, type ResponsePayload } from '../../response-registry.js';
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
}
const awaitingNameInput = new Map<string, PendingNameInput>();

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
 * such row, return false so the next handler (approvals module, OneCLI,
 * interactive) gets a shot.
 *
 * Approve: add the sender to agent_group_members + re-invoke routeInbound
 * with the stored event. The second routing attempt clears the gate because
 * the user is now a member.
 *
 * Deny: delete the row (no "deny list" — a future message re-triggers a
 * fresh card per ACTION-ITEMS item 5 "no denial persistence").
 */
async function handleSenderApprovalResponse(payload: ResponsePayload): Promise<boolean> {
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
    return true; // claim the response so it's not unclaimed-logged, but do nothing
  }
  const approverId = clickerId;
  const approved = payload.value === 'approve';

  if (approved) {
    await addMember({
      user_id: row.sender_identity,
      agent_group_id: row.agent_group_id,
      added_by: approverId,
      added_at: new Date().toISOString(),
    });
    log.info('Unknown sender approved — member added', {
      approvalId: row.id,
      senderIdentity: row.sender_identity,
      agentGroupId: row.agent_group_id,
      approverId,
    });

    // Clear the pending row BEFORE re-routing so the gate check on the
    // second attempt doesn't see the in-flight row and short-circuit.
    await deletePendingSenderApproval(row.id);

    try {
      const event = JSON.parse(row.original_message) as InboundEvent;
      await routeInbound(event);
    } catch (err) {
      log.error('Failed to replay message after sender approval', { approvalId: row.id, err });
    }
    return true;
  }

  log.info('Unknown sender denied', {
    approvalId: row.id,
    senderIdentity: row.sender_identity,
    agentGroupId: row.agent_group_id,
    approverId,
  });
  await deletePendingSenderApproval(row.id);
  return true;
}

registerResponseHandler(handleSenderApprovalResponse);

// ── Unknown-channel registration flow ──

setChannelRequestGate(async (mg, event) => {
  await requestChannelApproval({ messagingGroupId: mg.id, event });
});

/**
 * Wire an approved channel to an agent group and replay the stored event.
 * Shared by both approve paths (connect-existing button, free-text new-agent
 * name reply) so they produce identical wirings. Returns true when the wiring
 * was created — callers must not confirm success to the approver otherwise.
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
): Promise<boolean> {
  let event: InboundEvent;
  try {
    event = JSON.parse(row.original_message) as InboundEvent;
  } catch (err) {
    log.error('Channel registration: failed to parse stored event', {
      messagingGroupId: row.messaging_group_id,
      err,
    });
    await deletePendingChannelApproval(row.messaging_group_id);
    return false;
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
    return false;
  }

  const mgaId = `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
  log.info('Channel registration approved — wiring created', {
    messagingGroupId: row.messaging_group_id,
    agentGroupId,
    mgaId,
    engageMode: engage.engage_mode,
    approverId,
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

  await deletePendingChannelApproval(row.messaging_group_id);

  try {
    await routeInbound(event);
  } catch (err) {
    log.error('Failed to replay message after channel approval', {
      messagingGroupId: row.messaging_group_id,
      err,
    });
  }
  return true;
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
async function handleChannelApprovalResponse(payload: ResponsePayload): Promise<boolean> {
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
    return true;
  }
  const approverId = clickerId;

  // ── Reject / Cancel ──
  if (payload.value === REJECT_VALUE) {
    await setMessagingGroupDeniedAt(row.messaging_group_id, new Date().toISOString());
    await deletePendingChannelApproval(row.messaging_group_id);
    log.info('Channel registration denied', {
      messagingGroupId: row.messaging_group_id,
      approverId,
    });
    return true;
  }

  // ── Choose existing agent — send agent-selection follow-up card ──
  if (payload.value === CHOOSE_EXISTING_VALUE) {
    const approverDm = await ensureUserDm(row.approver_user_id);
    if (!approverDm) {
      log.error('Channel registration: no DM channel for approver', {
        messagingGroupId: row.messaging_group_id,
        approverUserId: row.approver_user_id,
      });
      return true;
    }

    const adapter = getDeliveryAdapter();
    if (!adapter) return true;

    const agentGroups = await getAllAgentGroups();
    const options = await buildAgentSelectionOptions(agentGroups, approverId);
    const title = '📋 Choose an agent';
    const question = `Which agent should handle this channel? ${AGENT_ACCESS_SCOPE_WARNING}`;
    await updatePendingChannelApprovalCard(row.messaging_group_id, title, question, JSON.stringify(options));

    try {
      await adapter.deliver(
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
      );
    } catch (err) {
      log.error('Channel registration: agent-selection card delivery failed', {
        messagingGroupId: row.messaging_group_id,
        err,
      });
    }
    return true;
  }

  // ── Create new agent — prompt for free-text name ──
  if (payload.value === NEW_AGENT_VALUE) {
    const approverDm = await ensureUserDm(row.approver_user_id);
    if (!approverDm) {
      log.error('Channel registration: no DM channel for approver', {
        messagingGroupId: row.messaging_group_id,
        approverUserId: row.approver_user_id,
      });
      return true;
    }

    const adapter = getDeliveryAdapter();
    if (!adapter) {
      log.error('Channel registration: no delivery adapter for name prompt', {
        messagingGroupId: row.messaging_group_id,
      });
      return true;
    }

    awaitingNameInput.set(row.approver_user_id, {
      channelMgId: row.messaging_group_id,
      dmChannelType: approverDm.channel_type,
      dmPlatformId: approverDm.platform_id,
    });

    try {
      await adapter.deliver(
        approverDm.channel_type,
        approverDm.platform_id,
        null,
        'chat-sdk',
        JSON.stringify({ text: 'Reply with the name for your new agent:' }),
      );
    } catch (err) {
      log.error('Channel registration: name prompt delivery failed', {
        messagingGroupId: row.messaging_group_id,
        err,
      });
      awaitingNameInput.delete(row.approver_user_id);
    }
    return true;
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
      await deletePendingChannelApproval(row.messaging_group_id);
      return true;
    }
    if (!(await hasAdminPrivilege(approverId, targetAgentGroupId))) {
      log.warn('Channel registration: target agent group rejected for unauthorized approver', {
        messagingGroupId: row.messaging_group_id,
        targetAgentGroupId,
        approverId,
      });
      return true;
    }
  } else {
    log.warn('Channel registration: unknown response value', {
      messagingGroupId: row.messaging_group_id,
      value: payload.value,
    });
    return true;
  }

  // ── Wire + replay (shared path for connect and create) ──
  await wireApprovedChannel(row, targetAgentGroupId, approverId);
  return true;
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

  const ag = await createNewAgentGroup(text);
  log.info('Channel registration: new agent group created', {
    messagingGroupId: row.messaging_group_id,
    agentGroupId: ag.id,
    agentName: ag.name,
    folder: ag.folder,
  });

  const wired = await wireApprovedChannel(row, ag.id, userId);

  const adapter = getDeliveryAdapter();
  if (adapter) {
    const dm = await ensureUserDm(row.approver_user_id);
    if (dm) {
      adapter
        .deliver(
          dm.channel_type,
          dm.platform_id,
          null,
          'chat-sdk',
          JSON.stringify({
            text: wired
              ? `✅ Agent "${ag.name}" created and connected.`
              : `⚠️ Agent "${ag.name}" was created but the channel couldn't be connected — check the host logs.`,
          }),
        )
        .catch(() => {});
    }
  }
  return true;
});
