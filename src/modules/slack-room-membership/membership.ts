/**
 * Slack room-membership handling (plan 04 §Slack-UI membership changes, D17).
 *
 * Reacts to member_joined_channel / member_left_channel events forwarded by
 * the Chat SDK bridge (generic membership seam: setMembershipHandler('slack',
 * …) — registration lives in ./index.ts). Four cases:
 *
 *  1. OWN bot joined an unknown channel/MPIM → the adopt flow: auto-create
 *     the messaging-group row (mirroring the router's auto-create shape) and
 *     fire the EXISTING channel-approval card with a synthesized greeting
 *     event — the card's dedupe (pending-row PK) rides along for free; the
 *     `denied_at` tombstone is checked here (the router only checks it on its
 *     own path). On approve the greeting replays through routeInbound, so the
 *     agent introduces itself. Since B2/D24 the card is the FALLBACK only:
 *     requestChannelApproval consults slackChannelCardInterceptor (below)
 *     first — owner present in the room → auto-wire 'public' +
 *     mention/accumulate, no card; unpaired 1:1 DMs → decline-and-notify.
 *  2. MPIM-fork carry-over: Slack NEVER adds members to a group DM in place —
 *     it forks a NEW conversation. Before firing the card in case 1, if the
 *     joined channel is an MPIM whose member set is a superset of an existing
 *     wired room's members (checked on this instance), mirror that room's mg
 *     rows + wirings — for EVERY instance wired to the old room, same engage
 *     values — onto the new channel id, carry the SLACK_A2A_ROOMS allowlist
 *     entry when the old room had one, and post a brief "room moved" note
 *     instead of asking for approval. The old room is left untouched.
 *  3. OWN bot left a wired channel → mark the mg detached (migration 021,
 *     `messaging_groups.detached_at`); a rejoin clears the flag. Routing goes
 *     quiet on its own (no more inbound events); delivery-side callers should
 *     consult `isMessagingGroupDetached` before sends.
 *  4. Anyone else (human or foreign bot) joined/left a WIRED room → concise
 *     system note into the room sessions of every wired agent group so agents
 *     know the membership changed. No approval, no gating (D17: a2a stays
 *     unrestricted for these rooms).
 *
 * The own-bot join path waits JOIN_RECHECK_DELAY_MS before deciding: when an
 * agent-provisioning flow itself opens an MPIM, the join event can beat the
 * flow's own room-wire writes — the recheck sees the flow's rows and stays
 * silent instead of approval-spamming the operator.
 */
import { resolveUnknownSenderPolicy } from '../../channels/channel-defaults.js';
import type { InboundEvent } from '../../channels/adapter.js';
import {
  botTokenKeyForInstance,
  slackAuthTest,
  slackConversationsInfo,
  slackConversationsMembers,
  slackPostMessage,
} from '../../channels/slack-lib.js';
import { projectDestinationsToSessions } from '../../cli/resources/destinations.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { recordDroppedMessage } from '../../db/dropped-messages.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getAllMessagingGroups,
  getMessagingGroupAgentByPair,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
  setMessagingGroupDetachedAt,
  updateMessagingGroup,
} from '../../db/messaging-groups.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { log } from '../../log.js';
import { routeInbound } from '../../router.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { MessagingGroup } from '../../types.js';
import { requestChannelApproval } from '../permissions/channel-approval.js';
import { getOwners } from '../permissions/db/user-roles.js';
import { declineAndNotify } from '../permissions/sender-approval.js';
import { appendToEnvList, readEnvValue } from './env-file.js';

/** Structural mirror of the bridge's MembershipEvent (generic membership
 *  seam) — declared locally so this file (and its tests) has no bridge
 *  import. */
export interface MembershipEvent {
  instance: string;
  channelType: string;
  channelId: string;
  userId: string;
  inviterId?: string;
  left?: boolean;
}

/** Test/config seam for handleSlackMembershipEvent. */
export interface MembershipOpts {
  /** Override the own-join recheck delay (tests pass 0). */
  joinRecheckDelayMs?: number;
  /** Repo root for .env reads; defaults to process.cwd(). */
  rootDir?: string;
}

/** Own-join settle window — covers the provisioning flow's open→wire gap. */
export const JOIN_RECHECK_DELAY_MS = 3000;

/**
 * Chat SDK 4.29 encodes member_joined_channel channel ids as Slack thread
 * ids (`slack:C…:`), while direct/test callers may still supply raw `C…` or
 * `G…` ids. Collapse both shapes before any DB lookup or Slack API call.
 *
 * The `slack` prefix allowlist deliberately covers named instances too:
 * multi-instance registration (slack-instances.ts, skill-installed) passes
 * `slack-<name>` only to the BRIDGE as a host-side routing key — the SDK
 * adapter underneath is always createSlackAdapter, whose encoded ids stay
 * `slack:C…:`-shaped, and the bridge forwards event.channelId verbatim. So
 * `slack-<name>:C…`-shaped ids do not occur. Revisit this helper if that
 * ever changes (e.g. an instance-named SDK adapter).
 */
function normalizeSlackMembershipChannelId(value: string): string | null {
  const parts = value.split(':');
  const raw =
    parts.length === 1
      ? parts[0]
      : (parts.length === 2 || parts.length === 3) && parts[0] === 'slack'
        ? parts[1]
        : undefined;
  return raw && /^[CG][A-Z0-9]+$/.test(raw) ? raw : null;
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

// ── Own-bot identity ──

/** auth.test result per instance — bot user ids are stable for a token's lifetime. */
const ownBotIdCache = new Map<string, string>();

/** Test seam: forget cached bot identities (tokens rotate between tests). */
export function clearOwnBotIdCache(): void {
  ownBotIdCache.clear();
}

async function resolveOwnBotUserId(instance: string, rootDir: string): Promise<string | undefined> {
  const cached = ownBotIdCache.get(instance);
  if (cached) return cached;
  const token = readEnvValue(rootDir, botTokenKeyForInstance(instance));
  if (!token) {
    log.debug('slack-room-membership: no bot token for instance — cannot resolve own identity', { instance });
    return undefined;
  }
  try {
    const auth = await slackAuthTest(token, 'membership');
    ownBotIdCache.set(instance, auth.userId);
    return auth.userId;
  } catch (err) {
    log.warn('slack-room-membership: auth.test failed resolving own bot identity', { instance, err });
    return undefined;
  }
}

// ── Case 1: adopt flow ──

/** Mirror of the router's auto-create shape (router.ts routeInbound step 1). */
async function createAdoptedMessagingGroup(instance: string, platformId: string): Promise<MessagingGroup> {
  const mg: MessagingGroup = {
    id: generateId('mg'),
    channel_type: 'slack',
    platform_id: platformId,
    instance,
    name: null,
    is_group: 1,
    unknown_sender_policy: resolveUnknownSenderPolicy(instance, true, 'slack'),
    denied_at: null,
    created_at: new Date().toISOString(),
  };
  await createMessagingGroup(mg);
  log.info('Auto-created messaging group (bot invited via Slack UI)', {
    id: mg.id,
    platformId,
    instance,
  });
  return mg;
}

/**
 * The replayable greeting standing in for the "original message" the
 * mention-triggered flow would have stored: on approve it routes like a
 * mention (isMention) and instructs the agent to introduce itself. The
 * inviter rides as sender/senderId, so the card shows invited-by context and
 * the approve path auto-admits the inviter as a member.
 */
function synthesizeJoinEvent(event: MembershipEvent, platformId: string): InboundEvent {
  const inviter = event.inviterId;
  return {
    channelType: 'slack',
    instance: event.instance,
    platformId,
    threadId: null,
    message: {
      id: `slack-join-${event.channelId}-${Date.now()}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      isMention: true,
      isGroup: true,
      content: JSON.stringify({
        text: inviter
          ? `<@${inviter}> invited the bot to this channel. Introduce yourself briefly and say what you can help with.`
          : 'The bot was added to this channel. Introduce yourself briefly and say what you can help with.',
        sender: inviter ? `<@${inviter}>` : 'system',
        ...(inviter ? { senderId: inviter, senderName: `<@${inviter}> (invited the bot)` } : {}),
      }),
    },
  };
}

// ── Case 2: MPIM-fork carry-over ──

async function tryMpimForkCarryOver(args: {
  instance: string;
  channelId: string;
  platformId: string;
  token: string;
  rootDir: string;
}): Promise<boolean> {
  let isMpim: boolean;
  try {
    isMpim = (await slackConversationsInfo(args.token, args.channelId, 'membership')).isMpim;
  } catch (err) {
    log.warn('slack-room-membership: conversations.info failed — skipping fork check', {
      channelId: args.channelId,
      err,
    });
    return false;
  }
  if (!isMpim) return false;

  let newMembers: Set<string>;
  try {
    newMembers = new Set(await slackConversationsMembers(args.token, args.channelId, 'membership'));
  } catch (err) {
    log.warn('slack-room-membership: conversations.members failed — skipping fork check', {
      channelId: args.channelId,
      err,
    });
    return false;
  }
  if (newMembers.size === 0) return false;

  const all = await getAllMessagingGroups();
  // Candidate old rooms: wired slack group rooms visible to THIS instance —
  // the superset check needs our bot in both channels for members reads.
  const candidates = all.filter(
    (m) =>
      m.channel_type === 'slack' &&
      m.is_group === 1 &&
      (m.instance ?? m.channel_type) === args.instance &&
      m.platform_id.startsWith('slack:') &&
      m.platform_id !== args.platformId &&
      !m.denied_at,
  );

  for (const candidate of candidates) {
    if ((await getMessagingGroupAgents(candidate.id)).length === 0) continue;
    const oldChannelId = candidate.platform_id.slice('slack:'.length);
    let oldMembers: string[];
    try {
      oldMembers = await slackConversationsMembers(args.token, oldChannelId, 'membership');
    } catch {
      continue; // bot no longer in the old room (or API hiccup) — not a fork source we can prove
    }
    if (oldMembers.length === 0 || !oldMembers.every((m) => newMembers.has(m))) continue;

    // Fork detected — mirror EVERY instance's row for the old room, same
    // agent groups, same engage values. The old room stays untouched (it
    // still works; Slack keeps both conversations alive).
    const now = new Date().toISOString();
    const family = all.filter((m) => m.channel_type === 'slack' && m.platform_id === candidate.platform_id);
    const carriedAgentGroups = new Set<string>();
    for (const oldMg of family) {
      const oldWirings = await getMessagingGroupAgents(oldMg.id);
      if (oldWirings.length === 0) continue;
      let newMg = await getMessagingGroupByPlatform('slack', args.platformId, oldMg.instance ?? 'slack');
      if (!newMg) {
        newMg = {
          id: generateId('mg'),
          channel_type: 'slack',
          platform_id: args.platformId,
          instance: oldMg.instance ?? 'slack',
          name: oldMg.name,
          is_group: 1,
          unknown_sender_policy: oldMg.unknown_sender_policy,
          denied_at: null,
          created_at: now,
        };
        await createMessagingGroup(newMg);
      }
      for (const oldWiring of oldWirings) {
        if (await getMessagingGroupAgentByPair(newMg.id, oldWiring.agent_group_id)) continue;
        await createMessagingGroupAgent({
          id: generateId('mga'),
          messaging_group_id: newMg.id,
          agent_group_id: oldWiring.agent_group_id,
          engage_mode: oldWiring.engage_mode,
          engage_pattern: oldWiring.engage_pattern,
          sender_scope: oldWiring.sender_scope,
          ignored_message_policy: oldWiring.ignored_message_policy,
          session_mode: oldWiring.session_mode,
          priority: oldWiring.priority,
          ...(oldWiring.threads !== undefined && oldWiring.threads !== null ? { threads: oldWiring.threads } : {}),
          created_at: now,
        });
        carriedAgentGroups.add(oldWiring.agent_group_id);
      }
    }
    for (const agentGroupId of carriedAgentGroups) {
      await projectDestinationsToSessions(agentGroupId);
    }

    // Carry the a2a allowlist entry when the old room had one.
    const allowlisted = (readEnvValue(args.rootDir, 'SLACK_A2A_ROOMS') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .includes(oldChannelId);
    if (allowlisted) {
      try {
        appendToEnvList(args.rootDir, 'SLACK_A2A_ROOMS', args.channelId);
      } catch (err) {
        log.warn('slack-room-membership: SLACK_A2A_ROOMS carry-over write failed', {
          channelId: args.channelId,
          err,
        });
      }
    }

    try {
      await slackPostMessage(
        args.token,
        args.channelId,
        "Room moved — I carried the previous room's wiring over. Same agents, same behavior; the old room keeps working too.",
      );
    } catch (err) {
      log.warn('slack-room-membership: room-moved note failed', { channelId: args.channelId, err });
    }

    log.info('MPIM fork carry-over applied', {
      fromChannelId: oldChannelId,
      toChannelId: args.channelId,
      instance: args.instance,
      agentGroups: [...carriedAgentGroups],
      a2aCarried: allowlisted,
    });
    return true;
  }
  return false;
}

// ── Case handlers ──

async function handleOwnJoin(event: MembershipEvent, platformId: string, opts: MembershipOpts): Promise<void> {
  // Settle window: a provisioning flow's own room rows land moments after
  // the join event when the flow itself opened the MPIM.
  await sleep(opts.joinRecheckDelayMs ?? JOIN_RECHECK_DELAY_MS);

  const rootDir = opts.rootDir ?? process.cwd();
  let mg = await getMessagingGroupByPlatform('slack', platformId, event.instance);
  if (mg && (await getMessagingGroupAgents(mg.id)).length > 0) {
    // Already wired (flow-created or previously adopted). A rejoin re-attaches.
    if (mg.detached_at) {
      await setMessagingGroupDetachedAt(mg.id, null);
      log.info('Messaging group re-attached — bot rejoined', { messagingGroupId: mg.id, platformId });
    }
    return;
  }
  if (mg?.denied_at) {
    log.debug('Bot invited to a denied channel — tombstone holds, no approval card', {
      messagingGroupId: mg.id,
      platformId,
    });
    return;
  }
  if (mg?.detached_at) await setMessagingGroupDetachedAt(mg.id, null);

  const token = readEnvValue(rootDir, botTokenKeyForInstance(event.instance));

  // Canvas shadow channels: creating a canvas on an MPIM makes Slack
  // materialize a hidden Slackbot-owned private channel as the canvas's
  // access container and add the room's members to it (observed live:
  // canvas F0… spawns channel C0… with the same id suffix). It fires real
  // member_joined events but is never a conversation to adopt — no mg row,
  // no approval card. Slackbot never creates adoptable channels, so the
  // creator check covers this class wholesale.
  if (token) {
    try {
      const info = await slackConversationsInfo(token, event.channelId, 'membership');
      if (info.creator === 'USLACKBOT') {
        log.debug('Ignoring Slackbot-created shadow channel', { channelId: event.channelId });
        return;
      }
    } catch (err) {
      log.warn('slack-room-membership: conversations.info failed — continuing without shadow check', {
        channelId: event.channelId,
        err,
      });
    }
  }

  if (
    token &&
    (await tryMpimForkCarryOver({
      instance: event.instance,
      channelId: event.channelId,
      platformId,
      token,
      rootDir,
    }))
  ) {
    return;
  }

  if (!mg) mg = await createAdoptedMessagingGroup(event.instance, platformId);
  // Dedupe of a second join/mention while pending is requestChannelApproval's
  // own in-flight check (pending_channel_approvals PK on messaging_group_id).
  // The owner-presence rule (D24) rides along for free: requestChannelApproval
  // consults slackChannelCardInterceptor below, so an owner-containing room
  // auto-wires (agent introduces itself via the synthesized greeting) and only
  // owner-absent rooms actually card.
  await requestChannelApproval({ messagingGroupId: mg.id, event: synthesizeJoinEvent(event, platformId) });
}

async function handleOwnLeft(event: MembershipEvent, platformId: string): Promise<void> {
  const mg = await getMessagingGroupByPlatform('slack', platformId, event.instance);
  if (!mg) return;
  await setMessagingGroupDetachedAt(mg.id, new Date().toISOString());
  log.info('Messaging group detached — bot left the channel', { messagingGroupId: mg.id, platformId });
}

/** Case 4: membership bookkeeping for wired rooms — a trigger=0 system note
 *  into every wired agent group's room sessions (D17: no approval, no gating). */
async function handleMemberChange(event: MembershipEvent, platformId: string): Promise<void> {
  const mg = await getMessagingGroupByPlatform('slack', platformId, event.instance);
  if (!mg || mg.is_group !== 1) return;
  const wirings = await getMessagingGroupAgents(mg.id);
  if (wirings.length === 0) return;

  const action = event.left ? 'left' : 'joined';
  const inviter = !event.left && event.inviterId ? ` (invited by <@${event.inviterId}>)` : '';
  const text = `Room membership changed: <@${event.userId}> ${action} this room${inviter}.`;
  const timestamp = new Date().toISOString();

  for (const wiring of wirings) {
    const sessions = (await getSessionsByAgentGroup(wiring.agent_group_id)).filter(
      (s) => s.messaging_group_id === mg.id && s.status === 'active',
    );
    for (const session of sessions) {
      try {
        // kind 'chat' + sender 'system' + channelType 'agent' mirrors the
        // container-restart system-note shape. NOT kind 'system': those rows
        // are reserved for MCP tool responses and the container poll loop
        // filters them out of agent batches (poll-loop.ts) — a 'system'-kind
        // note would sit pending forever and never reach the agent.
        await writeSessionMessage(wiring.agent_group_id, session.id, {
          id: generateId(`member-${event.channelId}`),
          kind: 'chat',
          timestamp,
          platformId,
          channelType: 'agent',
          threadId: null,
          content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
          trigger: false,
        });
      } catch (err) {
        log.warn('slack-room-membership: membership note write failed', {
          sessionId: session.id,
          messagingGroupId: mg.id,
          err,
        });
      }
    }
  }
  log.info('Room membership note written', { messagingGroupId: mg.id, userId: event.userId, action });
}

// ── Owner-presence access rule + channel-card interception (B2/D24) ──

/** Owner Slack user ids (raw U… form) from user_roles — the presence probe key. */
async function resolveOwnerSlackUserIds(): Promise<string[]> {
  return (await getOwners())
    .map((r) => r.user_id)
    .filter((id) => id.startsWith('slack:'))
    .map((id) => id.slice('slack:'.length));
}

/**
 * The agent group a Slack instance "is": the distinct agent group across the
 * instance's existing wirings, DM wirings first (every per-agent instance has
 * one). Exactly one distinct hit wins; ambiguous or empty → undefined and the
 * caller falls back to the approval card.
 */
async function resolveInstanceAgentGroup(instance: string): Promise<{ id: string; name: string } | undefined> {
  const rows = (await getAllMessagingGroups()).filter(
    (m) => m.channel_type === 'slack' && (m.instance ?? m.channel_type) === instance,
  );
  for (const dmOnly of [true, false]) {
    const ids = new Set<string>();
    for (const m of rows) {
      if (dmOnly && m.is_group !== 0) continue;
      for (const wiring of await getMessagingGroupAgents(m.id)) ids.add(wiring.agent_group_id);
    }
    if (ids.size === 1) {
      const id = [...ids][0]!;
      const ag = await getAgentGroup(id);
      if (ag) return { id, name: ag.name };
    }
  }
  return undefined;
}

/**
 * Dedupe key for the owner-absent channel decline. Constant on purpose — the
 * decline describes the channel, so it fires once per channel per the stamp's
 * 24h window regardless of who triggered it.
 */
const CHANNEL_DECLINE_KEY = 'channel:requires-owner';

/**
 * Owner-absent channel invite: decline it in place instead of asking the
 * owner to rule on it.
 *
 * Slack lets any workspace member add an installed app to a channel, and the
 * bot shows up in the member list immediately — visibly present before its
 * owner has consented to anything. The host already keeps it inert, so the
 * gap this closes is expectation, not authorization: everyone in the channel
 * sees a bot that looks like it is listening, and the only person told
 * otherwise was the owner.
 *
 * Three effects, none of them a wiring: one line in the channel explaining
 * the bot cannot be connected by whoever invited it and asking to be removed,
 * an informational FYI to the owner, and a dropped-message record. Nothing is
 * routed — the caller returns 'handled', so `requestChannelApproval` never
 * builds a card.
 *
 * The bot cannot remove itself: `conversations.leave` needs a channel write
 * scope the app does not carry, so the message has to ask a human.
 *
 * Dedupe is per CHANNEL, not per sender (declineAndNotify's default): the
 * decline is a fact about the conversation, and a second person mentioning
 * the bot should not produce a second post.
 */
async function declineChannelInvite(args: {
  mg: MessagingGroup;
  event: InboundEvent;
  agentGroup: { id: string; name: string } | undefined;
  channelName: string | null;
}): Promise<'handled'> {
  const { mg, event, agentGroup, channelName } = args;
  const sender = senderFromEvent(event);
  const where = channelName ? `#${channelName}` : 'a channel';
  const who = sender.name ?? sender.userId ?? 'Someone';

  try {
    await recordDroppedMessage({
      channel_type: 'slack',
      platform_id: event.platformId,
      user_id: sender.userId,
      sender_name: sender.name,
      reason: 'channel_requires_owner',
      messaging_group_id: mg.id,
      agent_group_id: agentGroup?.id ?? null,
    });

    await declineAndNotify({
      messagingGroupId: mg.id,
      agentGroupId: agentGroup?.id ?? null,
      senderIdentity: sender.userId,
      senderName: sender.name,
      event,
      dedupeKey: CHANNEL_DECLINE_KEY,
      declineText:
        "I can only be connected to a channel by my owner, so I won't respond here. " +
        'Please remove me from this channel — if my owner wants me here, they can add me back.',
      fyiText:
        `FYI: ${who} added your agent to ${where} on Slack. Only you can connect it there, so it ` +
        'declined in the channel and asked to be removed. Add it yourself if you do want it there.',
    });
  } catch (err) {
    // Fail closed to 'handled': the point of this branch is that an
    // owner-absent channel invite does not become a card, and a delivery
    // failure must not resurrect one.
    log.error('slack-room-membership: channel decline path failed — suppressed', {
      messagingGroupId: mg.id,
      err,
    });
  }
  return 'handled';
}

/** Sender identity off an inbound payload — top-level senderId/sender (v1,
 *  synthesized events) or the chat-sdk bridge's nested author.userId. */
function senderFromEvent(event: InboundEvent): { userId: string | null; name: string | null } {
  try {
    const parsed = JSON.parse(event.message.content) as Record<string, unknown>;
    const author =
      typeof parsed.author === 'object' && parsed.author !== null
        ? (parsed.author as Record<string, unknown>)
        : undefined;
    const raw =
      (typeof parsed.senderId === 'string' ? parsed.senderId : undefined) ??
      (typeof parsed.sender === 'string' ? parsed.sender : undefined) ??
      (typeof author?.userId === 'string' ? (author.userId as string) : undefined);
    const name =
      (typeof parsed.senderName === 'string' ? parsed.senderName : undefined) ??
      (typeof author?.fullName === 'string' ? (author.fullName as string) : undefined) ??
      null;
    if (!raw) return { userId: null, name };
    return { userId: raw.includes(':') ? raw : `slack:${raw}`, name };
  } catch {
    return { userId: null, name: null };
  }
}

/**
 * THE Slack channel-card interceptor (registered via
 * registerChannelCardInterceptor in ./index.ts) — consulted by
 * requestChannelApproval before any card goes out, which means BOTH
 * escalation paths funnel here: the router's mention path (step 1b) and this
 * module's own join-time adopt (handleOwnJoin calls requestChannelApproval).
 * Decides per D24's owner-presence rule:
 *
 *   - Slackbot-created shadow channel (canvas comment container) → silent
 *     'handled' — mirrors handleOwnJoin's guard for events that arrive via
 *     the mention path (canvases created outside our flow).
 *   - 1:1 DM, unknown sender → polite decline + owner FYI ('handled').
 *     Keyed on D24 itself, not on a pre-set policy value: the Slack
 *     adapter's declared DM default is still the pre-B2 'request_approval'
 *     (the declaration lives on the channels branch), so rows carrying that
 *     stale default decline exactly like 'decline_notify' ones and get
 *     stamped 'decline_notify' so the row matches the behavior. A wired DM
 *     never reaches channel registration, so every 1:1 DM here is unpaired
 *     and declines regardless of the sender's role or the stored policy.
 *   - Group/MPIM with the OWNER in the member list → auto-wire: mg flips to
 *     'public', the instance's agent group gets a mention/accumulate wiring
 *     (room semantics), the triggering event replays ('handled', no card).
 *   - Anything else (owner absent, no token, ambiguous instance→agent-group
 *     resolution, API failure) → 'card', today's notify-and-ask flow.
 */
export async function slackChannelCardInterceptor(
  mg: MessagingGroup,
  event: InboundEvent,
  opts: MembershipOpts = {},
): Promise<'card' | 'handled'> {
  const rootDir = opts.rootDir ?? process.cwd();
  const instance = mg.instance ?? 'slack';
  const token = readEnvValue(rootDir, botTokenKeyForInstance(instance));
  const channelId = mg.platform_id.startsWith('slack:') ? mg.platform_id.slice('slack:'.length) : mg.platform_id;

  // USLACKBOT backstop: shadow channels are never conversations to card.
  // The same lookup classifies the conversation for the owner-absent branch
  // below (MPIM vs channel) — one round trip, not two.
  let convInfo: { isMpim: boolean; name?: string; creator?: string } | null = null;
  if (token) {
    try {
      convInfo = await slackConversationsInfo(token, channelId, 'membership');
      if (convInfo.creator === 'USLACKBOT') {
        log.debug('Ignoring Slackbot-created shadow channel (card path)', { channelId });
        return 'handled';
      }
    } catch (err) {
      log.warn('slack-room-membership: conversations.info failed — continuing without shadow check', {
        channelId,
        err,
      });
    }
  }

  const isGroup = event.message.isGroup ?? mg.is_group === 1;
  const agentGroup = await resolveInstanceAgentGroup(instance);

  if (!isGroup) {
    // The paired user's DM is wired when the Slack agent is created and never
    // reaches this registration path. Every 1:1 DM here is therefore unpaired:
    // decline it regardless of membership, admin privilege, or stored policy.
    const sender = senderFromEvent(event);
    // Stamp the effective policy so ncl output and the access gate match the
    // paired-user-only DM behavior even on stale or operator-edited rows.
    if (mg.unknown_sender_policy !== 'decline_notify') {
      await updateMessagingGroup(mg.id, { unknown_sender_policy: 'decline_notify' });
    }
    await recordDroppedMessage({
      channel_type: 'slack',
      platform_id: event.platformId,
      user_id: sender.userId,
      sender_name: sender.name,
      reason: 'unknown_sender_decline_notify',
      messaging_group_id: mg.id,
      agent_group_id: agentGroup?.id ?? null,
    });
    const senderDisplay = sender.name ?? sender.userId ?? 'An unknown sender';
    const who =
      sender.userId && senderDisplay !== sender.userId ? `${senderDisplay} (${sender.userId})` : senderDisplay;
    await declineAndNotify({
      messagingGroupId: mg.id,
      agentGroupId: agentGroup?.id ?? null,
      senderIdentity: sender.userId,
      senderName: sender.name,
      event,
      fyiText:
        `FYI: ${who} DMed your agent on Slack — I sent a polite decline. ` +
        "This agent's Slack DM is private to its paired user.",
    });
    return 'handled';
  }

  // Group / MPIM / channel — the owner-presence rule proper.
  if (!token) return 'card';
  const ownerIds = await resolveOwnerSlackUserIds();
  if (ownerIds.length === 0) return 'card';
  let members: string[];
  try {
    members = await slackConversationsMembers(token, channelId, 'membership');
  } catch (err) {
    log.warn('slack-room-membership: conversations.members failed — falling back to the card', { channelId, err });
    return 'card';
  }
  if (!ownerIds.some((id) => members.includes(id))) {
    // Owner absent. A named channel is a surface anyone in the workspace can
    // drag the bot into, and Slack shows it as a member the moment they do —
    // before its owner has agreed to anything. Rather than ask the owner to
    // adjudicate an invitation they did not make, decline it the way an
    // unknown DM is declined: say so in the channel, tell the owner, wire
    // nothing. MPIMs keep the card — a group DM is a deliberate, small,
    // named set of people, and its invite is a normal ask.
    if (convInfo?.isMpim !== false) return 'card';
    return declineChannelInvite({ mg, event, agentGroup, channelName: convInfo.name ?? null });
  }

  if (!agentGroup) {
    log.warn('slack-room-membership: owner present but instance→agent-group resolution is ambiguous — card', {
      instance,
      channelId,
    });
    return 'card';
  }

  // Owner present → open: 'public' mg + mention/accumulate wiring (room
  // semantics — anyone there can task the agent; unmentioned chatter
  // accumulates as context). No card, no notification.
  await updateMessagingGroup(mg.id, { unknown_sender_policy: 'public' });
  if (!(await getMessagingGroupAgentByPair(mg.id, agentGroup.id))) {
    await createMessagingGroupAgent({
      id: generateId('mga'),
      messaging_group_id: mg.id,
      agent_group_id: agentGroup.id,
      engage_mode: 'mention',
      engage_pattern: null,
      sender_scope: 'all',
      ignored_message_policy: 'accumulate',
      session_mode: 'shared',
      priority: 0,
      created_at: new Date().toISOString(),
    });
  }
  await projectDestinationsToSessions(agentGroup.id);
  log.info('Owner present — channel auto-wired, no card', {
    messagingGroupId: mg.id,
    channelId,
    instance,
    agentGroupId: agentGroup.id,
  });

  // Replay the triggering event through normal routing so the agent answers
  // the mention (or introduces itself, on the join path's synthesized event).
  try {
    await routeInbound(event);
  } catch (err) {
    log.error('slack-room-membership: replay after auto-wire failed', { messagingGroupId: mg.id, err });
  }
  return 'handled';
}

// ── Entry ──

/**
 * THE membership handler (registered via setMembershipHandler('slack', …) in
 * ./index.ts). Never throws — the bridge fire-and-forgets, and a failure here
 * must never affect SDK dispatch or sibling events.
 */
export async function handleSlackMembershipEvent(event: MembershipEvent, opts: MembershipOpts = {}): Promise<void> {
  try {
    const channelId = normalizeSlackMembershipChannelId(event.channelId);
    if (!channelId) {
      log.warn('slack-room-membership: invalid channel id — ignoring membership event', {
        channelId: event.channelId,
        userId: event.userId,
      });
      return;
    }

    const normalizedEvent = channelId === event.channelId ? event : { ...event, channelId };
    const platformId = `slack:${channelId}`;
    const ownBotUserId = await resolveOwnBotUserId(normalizedEvent.instance, opts.rootDir ?? process.cwd());
    const isOwnBot = ownBotUserId !== undefined && normalizedEvent.userId === ownBotUserId;

    if (isOwnBot) {
      if (normalizedEvent.left) await handleOwnLeft(normalizedEvent, platformId);
      else await handleOwnJoin(normalizedEvent, platformId, opts);
      return;
    }
    await handleMemberChange(normalizedEvent, platformId);
  } catch (err) {
    log.error('slack-room-membership: event handling failed', {
      channelId: event.channelId,
      userId: event.userId,
      err,
    });
  }
}
