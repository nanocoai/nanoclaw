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
 *   - Create `messaging_group_agents` with defaults
 *     (mention-sticky for groups / pattern='.' for DMs,
 *      sender_scope='known', ignored_message_policy='accumulate')
 *   - Add the triggering sender to `agent_group_members` so sender_scope
 *     doesn't bounce the replayed message into a sender-approval cascade
 *   - Delete the pending row, replay the original event
 *
 * On connect new agent (handler in index.ts):
 *   - Prompt for a free-text agent name via DM
 *   - On reply: create the agent group + filesystem, then wire
 *     and replay as above
 *
 * On reject:
 *   - Set `messaging_groups.denied_at = now()` so the router stops
 *     escalating on this channel until an admin explicitly re-wires
 *   - Delete the pending row
 *
 * Dedup: `pending_channel_approvals` PK on messaging_group_id. Second
 * mention while pending silently dropped.
 *
 * Failure modes (log + no row, so a future attempt can try again):
 *   - No agent groups exist (install never set up a first agent).
 *   - No eligible approver in user_roles (no owner yet).
 *   - Approver has no reachable DM.
 *   - Delivery adapter missing.
 */
import { normalizeOptions, type NormalizedOption, type RawOption } from '../../channels/ask-question.js';
import { createAgentGroup, getAgentGroup, getAgentGroupByFolder, getAllAgentGroups } from '../../db/agent-groups.js';
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { getMessagingGroup, updateMessagingGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { initGroupFilesystem } from '../../group-init.js';
import { log } from '../../log.js';
import type { InboundEvent } from '../../channels/adapter.js';
import type { AgentGroup } from '../../types.js';
import { pickApprovalDelivery, pickApprover } from '../approvals/primitive.js';
import { createPendingChannelApproval, hasInFlightChannelApproval } from './db/pending-channel-approvals.js';
import { hasAdminPrivilege } from './db/user-roles.js';

// ── Value constants (response handler in index.ts parses these) ──

export const CONNECT_PREFIX = 'connect:';
export const NEW_AGENT_VALUE = 'new_agent';
export const CHOOSE_EXISTING_VALUE = 'choose_existing';
export const REJECT_VALUE = 'reject';

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

function visibleAgentGroupsForApprover(
  agentGroups: AgentGroup[],
  approverUserId: string | null | undefined,
): AgentGroup[] {
  if (!approverUserId) return agentGroups;
  return agentGroups.filter((agentGroup) => hasAdminPrivilege(approverUserId, agentGroup.id));
}

function buildApprovalOptions(agentGroups: AgentGroup[], approverUserId?: string | null): RawOption[] {
  const visibleAgentGroups = visibleAgentGroupsForApprover(agentGroups, approverUserId);
  const options: RawOption[] = [];
  if (visibleAgentGroups.length === 1) {
    options.push({
      label: `Connect to ${visibleAgentGroups[0].name}`,
      selectedLabel: `✅ Connected to ${visibleAgentGroups[0].name}`,
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
  isGroup: boolean,
  senderName: string | undefined,
  channelName: string | null,
  channelType: string,
): string {
  const who = senderName ?? 'Someone';
  if (isGroup) {
    const where = channelName ? `${channelName} on ${channelType}` : `a ${channelType} channel`;
    return `${who} mentioned your bot in ${where}. How would you like to handle this channel?`;
  }
  return `${who} sent your bot a DM on ${channelType}. How would you like to handle it?`;
}

// ── Main flow ──

export interface RequestChannelApprovalInput {
  messagingGroupId: string;
  event: InboundEvent;
}

export async function requestChannelApproval(input: RequestChannelApprovalInput): Promise<void> {
  const { messagingGroupId, event } = input;

  if (hasInFlightChannelApproval(messagingGroupId)) {
    log.debug('Channel registration already in flight — dropping retry', { messagingGroupId });
    return;
  }

  const agentGroups = getAllAgentGroups();
  if (agentGroups.length === 0) {
    log.warn('Channel registration skipped — no agent groups configured. Run /init-first-agent.', {
      messagingGroupId,
    });
    return;
  }
  // Use first agent group for approver resolution — owners and global admins
  // are returned regardless of which group we pass.
  const referenceGroup = agentGroups[0];

  const approvers = pickApprover(referenceGroup.id);
  if (approvers.length === 0) {
    log.warn('Channel registration skipped — no owner or admin configured', {
      messagingGroupId,
      targetAgentGroupId: referenceGroup.id,
    });
    return;
  }

  const originMg = getMessagingGroup(messagingGroupId);
  const originChannelType = originMg?.channel_type ?? '';

  // Resolve channel name if not yet persisted.
  if (originMg && !originMg.name) {
    const channelAdapter = getChannelAdapter(originChannelType);
    if (channelAdapter?.resolveChannelName) {
      try {
        const name = await channelAdapter.resolveChannelName(originMg.platform_id);
        if (name) {
          updateMessagingGroup(originMg.id, { name });
          originMg.name = name;
        }
      } catch {
        /* non-critical */
      }
    }
  }

  const delivery = await pickApprovalDelivery(approvers, originChannelType);
  if (!delivery) {
    log.warn('Channel registration skipped — no DM channel for any approver', {
      messagingGroupId,
      targetAgentGroupId: referenceGroup.id,
    });
    return;
  }

  const isGroup = event.message?.isGroup ?? originMg?.is_group === 1;

  let senderName: string | undefined;
  try {
    const parsed = JSON.parse(event.message.content) as Record<string, unknown>;
    senderName = (parsed.senderName ?? parsed.sender) as string | undefined;
  } catch {
    // non-critical
  }

  const channelName = originMg?.name ?? null;
  const title = isGroup ? '📣 Bot mentioned in new channel' : '💬 New direct message';
  const question = buildQuestionText(isGroup, senderName, channelName, originChannelType);
  const options = normalizeOptions(buildApprovalOptions(agentGroups, delivery.userId));

  createPendingChannelApproval({
    messaging_group_id: messagingGroupId,
    agent_group_id: referenceGroup.id,
    original_message: JSON.stringify(event),
    approver_user_id: delivery.userId,
    created_at: new Date().toISOString(),
    title,
    options_json: JSON.stringify(options),
  });

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.error('Channel registration row created but no delivery adapter is wired', { messagingGroupId });
    return;
  }

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
    );
    log.info('Channel registration card delivered', {
      messagingGroupId,
      agentGroupCount: agentGroups.length,
      approver: delivery.userId,
    });
  } catch (err) {
    log.error('Channel registration card delivery failed', { messagingGroupId, err });
  }
}

// ── Helpers for the response handler (index.ts) ──

/**
 * Build normalized options for the agent-selection follow-up card.
 */
export function buildAgentSelectionOptions(
  agentGroups: AgentGroup[],
  approverUserId?: string | null,
): NormalizedOption[] {
  const visibleAgentGroups = visibleAgentGroupsForApprover(agentGroups, approverUserId);
  const options: RawOption[] = visibleAgentGroups.map((ag) => ({
    label: ag.name,
    selectedLabel: `✅ Connected to ${ag.name}`,
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
 * folder-name collisions with numeric suffixes.
 */
export function createNewAgentGroup(name: string): AgentGroup {
  let folder = toFolder(name);
  const baseFolder = folder;
  let suffix = 2;
  while (getAgentGroupByFolder(folder)) {
    folder = `${baseFolder}-${suffix}`;
    suffix++;
  }

  const agId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  createAgentGroup({
    id: agId,
    name,
    folder,
    agent_provider: null,
    created_at: new Date().toISOString(),
  });

  const ag = getAgentGroup(agId)!;
  // Channel-approved groups get the built-in default provider (claude); the
  // operator flips a group with `ncl groups config update --provider`.
  initGroupFilesystem(ag);
  return ag;
}
