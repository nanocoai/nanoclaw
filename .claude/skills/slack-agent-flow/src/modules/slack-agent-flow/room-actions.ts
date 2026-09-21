/**
 * Agent-facing room actions: `create_room` and `add_to_room`
 * delivery-action bodies over the already-N-capable ensureAgentRoom.
 *
 * `create_room` is the "team room" primitive — the multi-agent pattern is N
 * `create_agent` calls with room:'none' followed by ONE create_room naming
 * all of them. Agent names resolve through the CALLER's a2a destination
 * namespace (the same names send_message uses), so an agent can only room
 * with agents it can already message. Each resolved agent group maps to its
 * Slack adapter instance via its wired messaging groups; bot identities come
 * from auth.test on the instance's .env token (botTokenKeyForInstance) —
 * token values never appear in notify texts or logs.
 *
 * `add_to_room` grows an existing room by one agent. Slack platform fact:
 * MPIMs NEVER grow in place — opening the superset member list FORKS a new
 * conversation id. ensureAgentRoom wires every participant onto the new id
 * directly, and the source room's actual member list is read first so
 * Slack-UI-added humans carry into the fork; the slack-room-membership
 * MPIM-fork carry-over (membership.ts) remains the path for Slack-UI adds
 * and stays silent here because the rows
 * already exist when its join-recheck fires. The old room is left untouched
 * (both conversations stay alive). For planned teams, prefer one complete
 * create_room over add_to_room chains.
 *
 * Failures surface to the requesting agent via notifyAgent — never silent.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import {
  getAllMessagingGroups,
  getMessagingGroup,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
  getMessagingGroupsByAgentGroup,
} from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import type { AgentGroup, MessagingGroup, Session } from '../../types.js';
import {
  getDestinationByName,
  getDestinationByTarget,
  normalizeName,
} from '../agent-to-agent/db/agent-destinations.js';
import { botTokenKeyForInstance, slackAuthTest, slackConversationsMembers } from '../../channels/slack-lib.js';
import { notifyAgent, requestApproval } from '../approvals/index.js';
import { readEnvValue } from './env-file.js';
import { ensureAgentRoom, publicPurpose, resolveOperatorSlackUserId, type RoomParticipant } from './orchestrate.js';

/** Domain failure with an agent-presentable message (no token values, ever). */
class RoomActionError extends Error {}

/** A room participant plus the bot token that proves it — token stays local. */
interface ResolvedParticipant extends RoomParticipant {
  botToken: string;
}

// ── Participant resolution ──

/**
 * An agent name → its agent group, through the CALLER's destination
 * namespace (normalizeName'd, same as send_message targets).
 */
async function resolveAgentByName(callerGroupId: string, name: string): Promise<AgentGroup> {
  const localName = normalizeName(name);
  const dest = await getDestinationByName(callerGroupId, localName);
  if (!dest || dest.target_type !== 'agent') {
    throw new RoomActionError(
      `unknown agent "${name}" — you have no agent destination named "${localName}". ` +
        `Use the names your send_message destinations use.`,
    );
  }
  const group = await getAgentGroup(dest.target_id);
  if (!group) throw new RoomActionError(`agent group behind destination "${localName}" no longer exists`);
  return group;
}

/** Bot token + auth.test identity for one adapter instance. */
async function identityForInstance(
  instanceKey: string,
  agentGroupName: string,
  rootDir: string,
): Promise<{ botToken: string; botUserId: string }> {
  const tokenKey = botTokenKeyForInstance(instanceKey);
  const botToken = readEnvValue(rootDir, tokenKey);
  if (!botToken) {
    throw new RoomActionError(`missing ${tokenKey} in .env for agent "${agentGroupName}" (instance '${instanceKey}')`);
  }
  const botUserId = (await slackAuthTest(botToken, 'room-resolve')).userId;
  return { botToken, botUserId };
}

/** Build the participant for a known (group, instance) pair. */
async function participantForInstance(
  group: AgentGroup,
  instanceKey: string,
  rootDir: string,
): Promise<ResolvedParticipant> {
  const { botToken, botUserId } = await identityForInstance(instanceKey, group.name, rootDir);
  return { instanceKey, botUserId, agentGroupId: group.id, agentGroupName: group.name, botToken };
}

/**
 * Build the participant for an agent group by finding its Slack adapter
 * instance among its wired messaging groups (a provisioned agent's DM and
 * rooms all live on its dedicated `slack-<slug>` instance; the origin agent
 * lives on its origin instance). Multiple distinct instances is a
 * pathological state — the first (sorted) with a token in .env wins.
 */
async function participantForAgentGroup(group: AgentGroup, rootDir: string): Promise<ResolvedParticipant> {
  const instances = [
    ...new Set(
      (await getMessagingGroupsByAgentGroup(group.id))
        .filter((mg) => mg.channel_type === 'slack')
        .map((mg) => mg.instance ?? 'slack'),
    ),
  ].sort();
  if (instances.length === 0) {
    throw new RoomActionError(
      `agent "${group.name}" has no Slack presence (no Slack wiring found) — was its Slack bot provisioned?`,
    );
  }
  const withToken = instances.find((key) => readEnvValue(rootDir, botTokenKeyForInstance(key)) !== undefined);
  if (!withToken) {
    throw new RoomActionError(
      `no bot token in .env for agent "${group.name}" (looked for ${instances.map(botTokenKeyForInstance).join(', ')})`,
    );
  }
  return participantForInstance(group, withToken, rootDir);
}

/**
 * The CALLING agent as a participant — its instance is the session's origin
 * instance when the request came in through Slack (mirrors runSlackAgentFlow),
 * else resolved from its wired messaging groups (task/a2a sessions).
 */
async function callerParticipant(session: Session, rootDir: string): Promise<ResolvedParticipant> {
  const group = await getAgentGroup(session.agent_group_id);
  if (!group) throw new RoomActionError('source agent group not found');
  const originMg = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
  if (originMg?.channel_type === 'slack') {
    return participantForInstance(group, originMg.instance ?? 'slack', rootDir);
  }
  return participantForAgentGroup(group, rootDir);
}

/** The caller's local destination name for a room channel on its instance. */
async function callerRoomDestination(
  callerGroupId: string,
  callerInstanceKey: string,
  roomChannelId: string,
  roomName: string,
): Promise<string> {
  const roomMg = await getMessagingGroupByPlatform('slack', `slack:${roomChannelId}`, callerInstanceKey);
  const dest = roomMg ? await getDestinationByTarget(callerGroupId, 'channel', roomMg.id) : undefined;
  return dest?.local_name ?? normalizeName(roomName);
}

/** `<@U…>, <@U…>` mention tags for every participant except the caller. */
function mentionTags(participants: RoomParticipant[], excludeGroupId: string): string {
  return participants
    .filter((p) => p.agentGroupId !== excludeGroupId)
    .map((p) => `<@${p.botUserId}>`)
    .join(', ');
}

// ── create_room ──

/** Guard precheck: malformed requests are answered without ever creating a hold. */
export async function validateCreateRoom(content: Record<string, unknown>, session: Session): Promise<boolean> {
  const name = typeof content.name === 'string' ? content.name.trim() : '';
  if (!name) {
    await notifyAgent(session, 'create_room failed: name is required.');
    return false;
  }
  const agents = Array.isArray(content.agents) ? content.agents : [];
  if (agents.length === 0 || !agents.every((a) => typeof a === 'string' && a.trim())) {
    await notifyAgent(session, 'create_room failed: agents must be a non-empty list of agent names.');
    return false;
  }
  if (!(await getAgentGroup(session.agent_group_id))) {
    await notifyAgent(session, 'create_room failed: source agent group not found.');
    return false;
  }
  return true;
}

/** Guard hold: card the requesting group's admin chain. */
export async function requestCreateRoomHold(content: Record<string, unknown>, session: Session): Promise<void> {
  const sourceGroup = await getAgentGroup(session.agent_group_id);
  if (!sourceGroup) return;
  const name = typeof content.name === 'string' ? content.name.trim() : '';
  const agents = (Array.isArray(content.agents) ? content.agents : []).filter(
    (a): a is string => typeof a === 'string',
  );

  await requestApproval({
    session,
    agentName: sourceGroup.name,
    action: 'create_room',
    // Same payload shape as the tool call — the approved replay re-enters
    // the wrapped action unchanged.
    payload: {
      name,
      agents,
      ...(typeof content.purpose === 'string' ? { purpose: content.purpose } : {}),
      ...(content.include_me === false ? { include_me: false } : {}),
    },
    title: `Create room: ${name}`,
    question:
      `Agent "${sourceGroup.name}" wants to open a shared Slack room "${name}" with you and ` +
      `${agents.join(', ')}${content.include_me === false ? ' (without itself)' : ''}. Approve?`,
  });
}

/**
 * Guard allow body: resolve every named agent (+ the caller unless
 * include_me:false), then hand the full participant list to ensureAgentRoom
 * — one MPIM with ALL bots + the operator, one canvas, mention/accumulate
 * wirings per instance, pairwise a2a destinations. The success notify tells
 * the CALLER to author the room intro (no host-templated intro).
 */
export async function handleCreateRoom(content: Record<string, unknown>, session: Session): Promise<void> {
  const name = (content.name as string).trim();
  const agentNames = (content.agents as string[]).map((a) => a.trim());
  const includeMe = content.include_me !== false;
  const rootDir = process.cwd();

  try {
    const operatorUserId = await resolveOperatorSlackUserId(session.agent_group_id);
    if (!operatorUserId) {
      throw new RoomActionError(
        'no approver with a Slack identity (slack:U…) found in user_roles — grant one with `ncl roles grant` and retry',
      );
    }

    // Caller first when included — it becomes the creator (opens the MPIM,
    // creates the canvas); otherwise the first listed agent does.
    const participants: ResolvedParticipant[] = [];
    const seen = new Set<string>();
    if (includeMe) {
      const caller = await callerParticipant(session, rootDir);
      seen.add(caller.agentGroupId);
      participants.push(caller);
    }
    for (const agentName of agentNames) {
      const group = await resolveAgentByName(session.agent_group_id, agentName);
      if (seen.has(group.id)) continue;
      seen.add(group.id);
      participants.push(await participantForAgentGroup(group, rootDir));
    }
    if (participants.length === 0) throw new RoomActionError('no agents resolved');
    const creator = participants[0]!;

    const { roomChannelId, created } = await ensureAgentRoom({
      creator,
      creatorBotToken: creator.botToken,
      operatorUserId,
      participants,
      roomName: name,
      purpose: publicPurpose(typeof content.purpose === 'string' ? content.purpose : undefined),
      rootDir,
    });

    const memberNames = participants.map((p) => p.agentGroupName).join(', ');
    if (!includeMe) {
      await notifyAgent(
        session,
        `Room "${name}" is live (${roomChannelId}) with the operator and ${memberNames}. ` +
          `You are not a member (include_me was false), so you cannot post there.`,
      );
    } else if (!created) {
      await notifyAgent(session, `Room "${name}" already existed (${roomChannelId}) — nothing new was created.`);
    } else {
      // The calling agent authors the intro, in its own voice.
      const roomDest = await callerRoomDestination(session.agent_group_id, creator.instanceKey, roomChannelId, name);
      await notifyAgent(
        session,
        `Room "${name}" is live (${roomChannelId}) with you, the operator, and ${memberNames}. ` +
          `Post a brief introduction there now via send_message({ to: "${roomDest}", ... }): ` +
          `1-2 lines in your own voice on what this room is for, tagging each agent literally ` +
          `(${mentionTags(participants, session.agent_group_id)}) — the tags render as mentions and are how you ` +
          `engage them there. Just the intro — no mechanics, no member lists.`,
      );
    }
    log.info('create_room completed', { roomChannelId, created, participantCount: participants.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await notifyAgent(session, `create_room failed: ${message}`);
    log.error('create_room failed', { name, err: message });
  }
}

// ── add_to_room ──

/** Guard precheck: malformed requests are answered without ever creating a hold. */
export async function validateAddToRoom(content: Record<string, unknown>, session: Session): Promise<boolean> {
  if (typeof content.room !== 'string' || !content.room.trim()) {
    await notifyAgent(session, 'add_to_room failed: room is required.');
    return false;
  }
  if (typeof content.agent !== 'string' || !content.agent.trim()) {
    await notifyAgent(session, 'add_to_room failed: agent is required.');
    return false;
  }
  if (!(await getAgentGroup(session.agent_group_id))) {
    await notifyAgent(session, 'add_to_room failed: source agent group not found.');
    return false;
  }
  return true;
}

/** Guard hold: card the requesting group's admin chain. */
export async function requestAddToRoomHold(content: Record<string, unknown>, session: Session): Promise<void> {
  const sourceGroup = await getAgentGroup(session.agent_group_id);
  if (!sourceGroup) return;
  const room = typeof content.room === 'string' ? content.room.trim() : '';
  const agent = typeof content.agent === 'string' ? content.agent.trim() : '';

  await requestApproval({
    session,
    agentName: sourceGroup.name,
    action: 'add_to_room',
    payload: { room, agent },
    title: `Add ${agent} to room: ${room}`,
    question:
      `Agent "${sourceGroup.name}" wants to add agent "${agent}" to the shared Slack room "${room}" ` +
      `(this opens a new group conversation with everyone plus "${agent}"). Approve?`,
  });
}

/**
 * The room named by an add_to_room call: wired Slack group rooms whose
 * messaging-group name matches (case-insensitive). Shadow channels never
 * match — their names carry a "canvas comments" suffix. When several rooms
 * share the name (e.g. earlier add_to_room forks keep the old room alive
 * under the same name), the NEWEST family wins — "the room" means its latest
 * incarnation.
 */
async function resolveRoomFamily(roomName: string): Promise<{ family: MessagingGroup[]; name: string }> {
  const wanted = roomName.trim().toLowerCase();
  const matches: MessagingGroup[] = [];
  for (const m of await getAllMessagingGroups()) {
    if (
      m.channel_type === 'slack' &&
      m.is_group === 1 &&
      !m.denied_at &&
      m.platform_id.startsWith('slack:') &&
      (m.name ?? '').trim().toLowerCase() === wanted &&
      (await getMessagingGroupAgents(m.id)).length > 0
    ) {
      matches.push(m);
    }
  }
  if (matches.length === 0) throw new RoomActionError(`no wired Slack room named "${roomName}" found`);
  const newestFirst = [...new Set(matches.map((m) => m.platform_id))]
    .map((pid) => ({
      pid,
      createdAt: matches
        .filter((m) => m.platform_id === pid)
        .map((m) => m.created_at)
        .sort()[0]!,
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const family = matches.filter((m) => m.platform_id === newestFirst[0]!.pid);
  return { family, name: family[0]!.name ?? roomName };
}

/**
 * Guard allow body: resolve the room's current participants from its wiring
 * rows, resolve the named agent, and re-run ensureAgentRoom with the
 * superset. The conversations.open on the superset member list FORKS a new
 * MPIM (Slack never grows one in place); ensureAgentRoom wires everyone onto
 * the new id, and the old room stays untouched — same shape the
 * slack-room-membership fork carry-over produces for Slack-UI adds.
 */
export async function handleAddToRoom(content: Record<string, unknown>, session: Session): Promise<void> {
  const roomArg = (content.room as string).trim();
  const agentArg = (content.agent as string).trim();
  const rootDir = process.cwd();

  try {
    const operatorUserId = await resolveOperatorSlackUserId(session.agent_group_id);
    if (!operatorUserId) {
      throw new RoomActionError(
        'no approver with a Slack identity (slack:U…) found in user_roles — grant one with `ncl roles grant` and retry',
      );
    }

    const { family, name: roomName } = await resolveRoomFamily(roomArg);

    // Current participants — one per wired agent group, on the room row's
    // own instance (router lookup is exact-on-instance, so the row is the
    // authoritative instance mapping).
    const participants: ResolvedParticipant[] = [];
    const seen = new Set<string>();
    for (const mg of family) {
      for (const wiring of await getMessagingGroupAgents(mg.id)) {
        if (seen.has(wiring.agent_group_id)) continue;
        seen.add(wiring.agent_group_id);
        const group = await getAgentGroup(wiring.agent_group_id);
        if (!group) continue;
        participants.push(await participantForInstance(group, mg.instance ?? 'slack', rootDir));
      }
    }

    const newGroup = await resolveAgentByName(session.agent_group_id, agentArg);
    if (seen.has(newGroup.id)) {
      await notifyAgent(session, `add_to_room: agent "${newGroup.name}" is already in room "${roomName}".`);
      return;
    }
    const newParticipant = await participantForAgentGroup(newGroup, rootDir);

    // Members added via the Slack UI (extra humans, foreign bots) exist only
    // on the platform — wiring rows carry agents alone. Read the source
    // room's actual member list so the forked superset carries them instead
    // of silently dropping them (the membership fork carry-over preserves
    // members for UI adds; this path must too). A failed read fails the
    // action (outer catch) — never a fork that quietly excludes someone.
    let extraMemberUserIds: string[] = [];
    if (participants.length > 0) {
      const sourceChannelId = family[0]!.platform_id.slice('slack:'.length);
      const knownIds = new Set([operatorUserId, newParticipant.botUserId, ...participants.map((p) => p.botUserId)]);
      const sourceMembers = await slackConversationsMembers(participants[0]!.botToken, sourceChannelId, 'room-resolve');
      extraMemberUserIds = sourceMembers.filter((id) => !knownIds.has(id));
    }

    // The NEW agent opens the superset MPIM (mirrors the create flow, where
    // the newly arriving bot is the opener/canvas creator).
    const { roomChannelId } = await ensureAgentRoom({
      creator: newParticipant,
      creatorBotToken: newParticipant.botToken,
      operatorUserId,
      participants: [...participants, newParticipant],
      extraMemberUserIds,
      roomName,
      rootDir,
    });

    const callerInRoom = seen.has(session.agent_group_id);
    let callerMg: MessagingGroup | undefined;
    for (const mg of family) {
      if ((await getMessagingGroupAgents(mg.id)).some((w) => w.agent_group_id === session.agent_group_id)) {
        callerMg = mg;
        break;
      }
    }
    const roomDestination = callerMg
      ? await callerRoomDestination(session.agent_group_id, callerMg.instance ?? 'slack', roomChannelId, roomName)
      : undefined;
    const intro =
      callerInRoom && callerMg
        ? ` Post a brief introduction of ${newParticipant.agentGroupName} there now via send_message({ to: ` +
          `"${roomDestination}", ... }): ` +
          `1-2 lines in your own voice, tagging them with <@${newParticipant.botUserId}> (include that literally — ` +
          `it renders as a mention). Just the intro — no mechanics, no member lists.`
        : '';
    await notifyAgent(
      session,
      `${newParticipant.agentGroupName} was added to room "${roomName}". Slack group DMs never grow in place, ` +
        `so the room moved to a new conversation (${roomChannelId}) — everyone is wired there and the old ` +
        `conversation keeps working.${intro}`,
    );
    log.info('add_to_room completed', { roomChannelId, agentGroupId: newGroup.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await notifyAgent(session, `add_to_room failed: ${message}`);
    log.error('add_to_room failed', { room: roomArg, agent: agentArg, err: message });
  }
}
