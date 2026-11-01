/**
 * Unknown-channel registration flow.
 *
 * When the router hits an unwired messaging group AND the message was
 * addressed to the bot (SDK-confirmed mention or DM), it calls
 * `requestChannelApproval` instead of silently dropping. The flow:
 *
 *   1. Gather all existing agent groups.
 *   2. Pick an eligible approver (owner / admin) and a reachable DM for
 *      them, reusing the same primitives the sender-approval flow uses.
 *   3. Deliver a card with three action families:
 *        a. Connect to [agent] — one button per existing agent group.
 *           Single-agent installs get a one-click connect.
 *        b. Connect new agent — prompts for a free-text name, creates
 *           the agent immediately on reply.
 *        c. Reject — deny the channel.
 *   4. Record a `pending_channel_approvals` row holding the original event
 *      so it can be re-routed on connect/create.
 *
 * On connect (handler in index.ts):
 *   - Create `messaging_group_agents` with the channel's declared engage
 *     defaults (resolveWiringDefaults, DM vs group context;
 *      sender_scope='known', ignored_message_policy='accumulate')
 *   - Add the triggering sender to `agent_group_members` so sender_scope
 *     doesn't bounce the replayed message into a sender-approval cascade
 *   - Delete the pending row, replay the original event
 *
 * On connect new agent (handler in index.ts):
 *   - Prompt for a free-text agent name via DM
 *   - On reply: create the agent group + filesystem, then wire
 *     and replay as above. A name whose folder can't be a group folder
 *     creates nothing; the approver is told and asked for another name.
 *
 * On reject:
 *   - Set `messaging_groups.denied_at = now()` so the router stops
 *     escalating on this channel until an admin explicitly re-wires
 *   - Delete the pending row
 *
 * Dedup: `pending_channel_approvals` PK on messaging_group_id. Second
 * mention while pending silently dropped.
 *
 * Delivery is confirmed, not assumed: the card goes to the first approver
 * DM (same channel kind first) whose send succeeds. A send that throws (e.g.
 * no bot has a DM with that approver: Telegram's "chat not found") moves the
 * card, and the pending row's approver, to the next candidate.
 *
 * Failure modes (log + no row, so a future attempt can try again):
 *   - No agent groups exist (install never set up a first agent).
 *   - No eligible approver in user_roles (no owner yet).
 *   - No approver has a reachable DM, or every send failed (the host's
 *     undeliverable handler is told, so the owner hears another way).
 *   - Delivery adapter missing (undeliverable handler too).
 */
import { normalizeOptions, type NormalizedOption, type RawOption } from '../../channels/ask-question.js';
import { escapeInvisibles, quoteForCard } from '../../card-text.js';
import { resolveWiringDefaults } from '../../channels/channel-defaults.js';
import { createAgentGroup, getAgentGroup, getAllAgentGroups } from '../../db/agent-groups.js';
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { getMessagingGroup, updateMessagingGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { newGroupFolder } from '../../group-folder.js';
import { initGroupFilesystem } from '../../group-init.js';
import { log } from '../../log.js';
import { logId } from '../../log-id.js';
import type { InboundEvent, ResolvedConversation } from '../../channels/adapter.js';
import type { AgentGroup, MessagingGroup } from '../../types.js';
import { approvalDeliveryCandidates, pickApprover } from '../approvals/primitive.js';
import {
  createPendingChannelApproval,
  deletePendingChannelApproval,
  hasInFlightChannelApproval,
  updatePendingChannelApprovalApprover,
} from './db/pending-channel-approvals.js';
import { hasAdminPrivilege } from './db/user-roles.js';

// ── Value constants (response handler in index.ts parses these) ──

export const CONNECT_PREFIX = 'connect:';
export const NEW_AGENT_VALUE = 'new_agent';
export const CHOOSE_EXISTING_VALUE = 'choose_existing';
export const REJECT_VALUE = 'reject';
// This deliberately does not claim "the same authority as you": approved members cannot run admin commands,
// which command-gate.ts gates on hasAdminPrivilege, but it names the real shared context, workspace, memory, and tool blast radius.
export const AGENT_ACCESS_SCOPE_WARNING =
  "Anyone approved here can interact with the agent and potentially access anything the agent can access, including other conversations' context, its workspace files and memory, and any connected tools.";

// ── Channel-card interceptor seam (B2/D24) ──
// A channel module can claim the escalation for its own channel type before
// a registration card goes out — e.g. the slack-room-membership module's
// owner-presence rule (owner in the room → auto-wire, no card) and its
// Slackbot shadow-channel backstop. The seam is deliberately generic: this
// module registers/consults by channel_type only and never imports channel
// code. 'handled' = the interceptor consumed the escalation (wired, declined,
// or deliberately ignored it); 'card' = proceed with today's card flow.
// Interceptor errors fall back to the card — a broken module must never make
// escalations silently vanish.

export type ChannelCardDecision = 'card' | 'handled';
export type ChannelCardInterceptor = (mg: MessagingGroup, event: InboundEvent) => Promise<ChannelCardDecision>;

const channelCardInterceptors = new Map<string, ChannelCardInterceptor>();

export function registerChannelCardInterceptor(channelType: string, fn: ChannelCardInterceptor): void {
  if (channelCardInterceptors.has(channelType)) {
    log.warn('Channel-card interceptor overwritten', { channelType });
  }
  channelCardInterceptors.set(channelType, fn);
}

// ── Undeliverable fallback seam ──
// The engine can't reach the owner when no approver DM accepts the card, so
// the host decides how to tell them another way (e.g. a dashboard notice).
// Carries no user or platform ids: only what a notice may show.

export interface ChannelApprovalUndeliverable {
  messagingGroupId: string;
  channelType: string;
  channelName: string | null;
  title: string;
  reason: 'no_reachable_approver' | 'all_deliveries_failed' | 'no_delivery_adapter';
  /** Card sends attempted (each failed). */
  attempts: number;
}
export type ChannelApprovalUndeliverableHandler = (info: ChannelApprovalUndeliverable) => Promise<void> | void;

let undeliverableHandler: ChannelApprovalUndeliverableHandler | null = null;

export function setChannelApprovalUndeliverableHandler(fn: ChannelApprovalUndeliverableHandler | null): void {
  undeliverableHandler = fn;
}

async function reportUndeliverable(info: ChannelApprovalUndeliverable): Promise<void> {
  log.warn('Channel registration card undeliverable', {
    messagingGroupId: info.messagingGroupId,
    channelType: info.channelType,
    reason: info.reason,
    attempts: info.attempts,
    fallback: undeliverableHandler ? 'host' : 'none',
  });
  if (!undeliverableHandler) return;
  /* eslint-disable no-catch-all/no-catch-all -- a broken host fallback must not fail the inbound route */
  try {
    await undeliverableHandler(info);
  } catch (err) {
    log.warn('Channel registration undeliverable fallback failed', { messagingGroupId: info.messagingGroupId, err });
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

// ── Utilities ──

function toFolder(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unnamed'
  );
}

// ── Card builders ──

async function visibleAgentGroupsForApprover(
  agentGroups: AgentGroup[],
  approverUserId: string | null | undefined,
): Promise<AgentGroup[]> {
  if (!approverUserId) return agentGroups;
  const visible: AgentGroup[] = [];
  for (const agentGroup of agentGroups) {
    if (await hasAdminPrivilege(approverUserId, agentGroup.id)) visible.push(agentGroup);
  }
  return visible;
}

async function buildApprovalOptions(agentGroups: AgentGroup[], approverUserId?: string | null): Promise<RawOption[]> {
  const visibleAgentGroups = await visibleAgentGroupsForApprover(agentGroups, approverUserId);
  const options: RawOption[] = [];
  if (visibleAgentGroups.length === 1) {
    options.push({
      label: `Connect to ${visibleAgentGroups[0].name}`,
      selectedLabel: `✅ Connected to ${quoteForCard(visibleAgentGroups[0].name)}`,
      value: `${CONNECT_PREFIX}${visibleAgentGroups[0].id}`,
      style: 'primary',
    });
  } else if (visibleAgentGroups.length > 1) {
    options.push({
      label: 'Choose existing agent',
      selectedLabel: '📋 Choosing…',
      value: CHOOSE_EXISTING_VALUE,
    });
  }
  options.push({
    label: 'Connect new agent',
    selectedLabel: '🆕 Connecting new agent…',
    value: NEW_AGENT_VALUE,
  });
  options.push({
    label: 'Reject',
    selectedLabel: '🙅 Rejected',
    value: REJECT_VALUE,
    style: 'danger',
  });
  return options;
}

function buildQuestionText(
  conversationType: ResolvedConversation['type'],
  senderName: string | undefined,
  senderId: string | undefined,
  channelName: string | null,
  channelType: string,
  ruleNote: string | null,
  resolvedConversation: ResolvedConversation | null,
): string {
  const who = senderName ? quoteForCard(senderName) : 'Someone';
  const note = ruleNote ? ` If connected, the agent ${ruleNote}.` : '';
  if (conversationType === 'channel') {
    const where = channelName ? `${quoteForCard(channelName)} on ${channelType}` : `a ${channelType} channel`;
    return `${who} mentioned your bot in ${where}.${note} ${AGENT_ACCESS_SCOPE_WARNING} How would you like to handle this channel?`;
  }
  if (conversationType === 'group_dm') {
    const participantNames = resolvedConversation?.participantNames ?? [];
    const participantIds = resolvedConversation?.participantIds;
    const useParticipantIds = Boolean(senderId) && participantIds?.length === participantNames.length;
    const otherParticipants = participantNames.filter((name, index) =>
      useParticipantIds ? participantIds![index] !== senderId : name.toLowerCase() !== senderName?.toLowerCase(),
    );
    const participants = formatParticipantList(otherParticipants.map(quoteForCard));
    const withParticipants = participants ? ` with ${participants}` : '';
    return `${who} mentioned your bot in a group chat${withParticipants} on ${channelType}.${note} ${AGENT_ACCESS_SCOPE_WARNING} How would you like to handle this group chat?`;
  }
  return `${who} sent your bot a DM on ${channelType}.${note} ${AGENT_ACCESS_SCOPE_WARNING} How would you like to handle it?`;
}

function formatParticipantList(names: string[]): string {
  if (names.length < 2) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
}

/**
 * Human summary of the engage rule an approval would create, from the same
 * resolution the wire step uses. Null when the declaration is unresolvable
 * (mis-declared pattern mode) — the card still works without the preview.
 */
/** Exported for tests. */
export function describeResolvedRule(
  channelKey: string,
  isGroup: boolean,
  agentGroupName: string,
  channelType: string,
): string | null {
  try {
    const engage = resolveWiringDefaults(channelKey, isGroup, agentGroupName, channelType);
    if (engage.engage_mode !== 'pattern') {
      return isGroup ? 'will respond to @-mentions in this group' : 'will respond to @-mentions';
    }
    return engage.engage_pattern === '.'
      ? 'will respond to all messages'
      : `will respond to messages matching \`${escapeInvisibles(engage.engage_pattern ?? '')}\``;
  } catch {
    return null;
  }
}

// ── Main flow ──

export interface RequestChannelApprovalInput {
  messagingGroupId: string;
  event: InboundEvent;
}

export async function requestChannelApproval(input: RequestChannelApprovalInput): Promise<void> {
  const { messagingGroupId, event } = input;

  if (await hasInFlightChannelApproval(messagingGroupId)) {
    log.debug('Channel registration already in flight — dropping retry', { messagingGroupId });
    return;
  }

  const originMg = await getMessagingGroup(messagingGroupId);

  // Channel-module interceptor: consulted before any card work so a module
  // can auto-wire / decline / suppress for its own channel type. Runs after
  // the in-flight dedupe (a pending card already owns this channel) and
  // before the approver checks (an auto-wire needs no reachable approver).
  const interceptor = originMg ? channelCardInterceptors.get(originMg.channel_type) : undefined;
  if (originMg && interceptor) {
    try {
      if ((await interceptor(originMg, event)) === 'handled') {
        log.debug('Channel registration handled by interceptor — no card', {
          messagingGroupId,
          channelType: originMg.channel_type,
        });
        return;
      }
    } catch (err) {
      log.warn('Channel-card interceptor threw — falling back to the card', { messagingGroupId, err });
    }
  }

  const agentGroups = await getAllAgentGroups();
  if (agentGroups.length === 0) {
    log.warn('Channel registration skipped — no agent groups configured. Run /init-first-agent.', {
      messagingGroupId,
    });
    return;
  }
  // Use first agent group for approver resolution — owners and global admins
  // are returned regardless of which group we pass.
  const referenceGroup = agentGroups[0];

  const approvers = await pickApprover(referenceGroup.id);
  if (approvers.length === 0) {
    log.warn('Channel registration skipped — no owner or admin configured', {
      messagingGroupId,
      targetAgentGroupId: referenceGroup.id,
    });
    return;
  }

  const originChannelType = originMg?.channel_type ?? '';

  // Resolve conversation metadata and, when needed, its legacy name. Key by
  // instance so a named instance's own adapter (and bot identity) does the lookup.
  let resolvedConversation: ResolvedConversation | null = null;
  if (originMg) {
    const channelAdapter = getChannelAdapter(originMg.instance ?? originMg.channel_type);
    if (channelAdapter?.resolveConversation) {
      try {
        resolvedConversation = await channelAdapter.resolveConversation(originMg.platform_id);
        if (resolvedConversation?.name && !originMg.name) {
          await updateMessagingGroup(originMg.id, { name: resolvedConversation.name });
          originMg.name = resolvedConversation.name;
        }
      } catch {
        /* non-critical */
      }
    }
    if (!originMg.name && channelAdapter?.resolveChannelName) {
      try {
        const name = await channelAdapter.resolveChannelName(originMg.platform_id);
        if (name) {
          await updateMessagingGroup(originMg.id, { name });
          originMg.name = name;
        }
      } catch {
        /* non-critical */
      }
    }
  }

  const isGroup = event.message?.isGroup ?? originMg?.is_group === 1;

  let senderName: string | undefined;
  let senderId: string | undefined;
  try {
    const parsed = JSON.parse(event.message.content) as Record<string, unknown>;
    senderName = (parsed.senderName ?? parsed.sender) as string | undefined;
    senderId = parsed.senderId as string | undefined;
  } catch {
    // non-critical
  }

  const conversationType = resolvedConversation?.type ?? (isGroup ? 'channel' : 'direct');
  const channelName = originMg?.name ?? null;
  const title =
    conversationType === 'channel'
      ? '📣 Bot mentioned in new channel'
      : conversationType === 'group_dm'
        ? '👥 Bot mentioned in new group chat'
        : '💬 New direct message';
  // Preview the engage rule an approval would create. The reference group's
  // name only feeds {name} pattern substitution — a best-effort preview when
  // the approver ends up picking a different agent.
  const ruleNote = describeResolvedRule(
    originMg?.instance ?? originChannelType,
    isGroup,
    referenceGroup.name,
    originChannelType,
  );
  const question = buildQuestionText(
    conversationType,
    senderName,
    senderId,
    channelName,
    originChannelType,
    ruleNote,
    resolvedConversation,
  );
  const undeliverable = (reason: ChannelApprovalUndeliverable['reason'], attempts: number) =>
    reportUndeliverable({
      messagingGroupId,
      channelType: originChannelType,
      channelName,
      title,
      reason,
      attempts,
    });

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.error('Channel registration skipped — no delivery adapter is wired', { messagingGroupId });
    await undeliverable('no_delivery_adapter', 0);
    return;
  }

  // The row exists before each send so an immediate click finds it, and names
  // the approver that send targets, so only they can decide it.
  let rowCreated = false;
  let attempts = 0;
  for await (const delivery of approvalDeliveryCandidates(approvers, originChannelType, originMg?.instance)) {
    const options = normalizeOptions(await buildApprovalOptions(agentGroups, delivery.userId));
    if (!rowCreated) {
      await createPendingChannelApproval({
        messaging_group_id: messagingGroupId,
        agent_group_id: referenceGroup.id,
        original_message: JSON.stringify(event),
        approver_user_id: delivery.userId,
        created_at: new Date().toISOString(),
        title,
        question,
        options_json: JSON.stringify(options),
      });
      rowCreated = true;
    } else {
      await updatePendingChannelApprovalApprover(messagingGroupId, delivery.userId, JSON.stringify(options));
    }
    attempts++;
    try {
      await adapter.deliver(
        delivery.messagingGroup.channel_type,
        delivery.messagingGroup.platform_id,
        null,
        'chat-sdk',
        JSON.stringify({
          type: 'ask_question',
          questionId: messagingGroupId,
          title,
          question,
          options,
        }),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        delivery.messagingGroup.instance,
      );
      log.info('Channel registration card delivered', {
        messagingGroupId,
        agentGroupCount: agentGroups.length,
        approver: logId(delivery.userId),
        channelType: delivery.messagingGroup.channel_type,
        attempts,
      });
      return;
    } catch (err) {
      log.warn('Channel registration card delivery failed — trying the next approver', {
        messagingGroupId,
        approver: logId(delivery.userId),
        channelType: delivery.messagingGroup.channel_type,
        err,
      });
    }
  }

  if (rowCreated) await deletePendingChannelApproval(messagingGroupId);
  if (attempts === 0) {
    log.warn('Channel registration skipped — no DM channel for any approver', {
      messagingGroupId,
      targetAgentGroupId: referenceGroup.id,
    });
  }
  await undeliverable(attempts === 0 ? 'no_reachable_approver' : 'all_deliveries_failed', attempts);
}

// ── Helpers for the response handler (index.ts) ──

/**
 * Build normalized options for the agent-selection follow-up card.
 */
export async function buildAgentSelectionOptions(
  agentGroups: AgentGroup[],
  approverUserId?: string | null,
): Promise<NormalizedOption[]> {
  const visibleAgentGroups = await visibleAgentGroupsForApprover(agentGroups, approverUserId);
  const options: RawOption[] = visibleAgentGroups.map((ag) => ({
    label: ag.name,
    selectedLabel: `✅ Connected to ${quoteForCard(ag.name)}`,
    value: `${CONNECT_PREFIX}${ag.id}`,
  }));
  options.push({
    label: 'Cancel',
    selectedLabel: '🙅 Cancelled',
    value: REJECT_VALUE,
  });
  return normalizeOptions(options);
}

/**
 * Create a new agent group and initialize its filesystem. Handles
 * folder-name collisions with numeric suffixes. Returns why, writing nothing,
 * when the folder can't be a group folder.
 */
export async function createNewAgentGroup(name: string): Promise<AgentGroup | string> {
  let folder: string;
  try {
    folder = await newGroupFolder(toFolder(name));
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    log.warn('Channel registration: new agent refused, invalid folder', { name, why });
    return why;
  }

  const agId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await createAgentGroup({
    id: agId,
    name,
    folder,
    agent_provider: null,
    created_at: new Date().toISOString(),
  });

  const ag = (await getAgentGroup(agId))!;
  // Channel-approved groups are created on the instance default provider
  // (DEFAULT_AGENT_PROVIDER, or claude when unset) — initGroupFilesystem stamps
  // it onto the fresh config row. The operator flips a group afterward with
  // `ncl groups config update --provider`.
  await initGroupFilesystem(ag);
  return ag;
}
