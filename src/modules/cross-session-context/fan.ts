/**
 * Cross-session context — accumulate fan-out.
 *
 * Copies triggering user messages (router hook) and the agent's own delivered
 * user-facing messages (delivery hook) into sibling sessions of the same agent
 * group as trigger=0 rows with channel_type 'session-echo'. Echo rows ride
 * along as ambient context with the next real trigger — they never wake a
 * container, never provide reply routing (thread_id NULL; the formatter's
 * reply-routing extraction skips 'session-echo'), and are never themselves
 * fanned (loop guard: fan entries reject 'session-echo' rows, and fan writes
 * go through writeSessionMessage, which never re-enters routeInbound).
 *
 * Audience rule: a message fans
 * ONLY into sibling sessions of the conversation it actually appeared in —
 * for inbound, the messaging group it arrived on; for outbound, the
 * messaging group it was delivered to. Same messaging group = identical
 * audience by definition, so every fan is provably audience-safe with no
 * membership knowledge needed. Nothing else is ever a target: not the
 * group's other conversations (room→DM is retired), not task sessions
 * (conversation→task is retired — task sessions have no messaging group).
 * Cross-conversation awareness is pull-only: `ncl sessions history`.
 * Task sessions are still never an inbound source (the series prompt is
 * series-internal); a task's DELIVERED user-facing send fans like any other
 * delivery — into the sessions of the conversation it landed in.
 */
import {
  getMessagingGroup,
  getMessagingGroupByPlatform,
  getMessagingGroupForOwnDestination,
} from '../../db/messaging-groups.js';
import { getSessionsByAgentGroup, isTaskThread } from '../../db/sessions.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { AgentGroup, MessagingGroup, Session } from '../../types.js';
import { ECHO_CHANNEL_TYPE, ECHO_SIBLING_SURFACE, ECHO_TASK_SURFACE, ECHO_TEXT_MAX_CHARS } from './config.js';

/** Surface values that appear on the wire in echo.{surface}: the sibling-
 *  thread marker and the task-delivery marker (backfill's dm-timeline is
 *  written by backfill.ts directly). Every fan target is a session of the
 *  conversation the message appeared in, so the old cross-surface 'dm'/'room'
 *  values are no longer emitted. */
export type EchoWireSurface = typeof ECHO_SIBLING_SURFACE | typeof ECHO_TASK_SURFACE;

/** Inbound kinds that are real chat traffic. Everything else (task, system,
 *  approval plumbing) never fans. */
const CHAT_KINDS = new Set(['chat', 'chat-sdk']);

/** Head-truncate to the cap, appending '…' when cut (contract: ≤500 chars). */
export function truncateEchoText(text: string): string {
  return text.length <= ECHO_TEXT_MAX_CHARS ? text : `${text.slice(0, ECHO_TEXT_MAX_CHARS)}…`;
}

/** Echo-row id: namespaced by target session so the same source message can
 *  land in every sibling inbound.db without PK collisions (contract shape). */
export function echoRowId(origMessageId: string, targetSessionId: string): string {
  return `${origMessageId}:echo:${targetSessionId}`;
}

/** Human label for the source conversation, e.g. '#Pixel room' / 'DM with Gavriel'. */
export function buildEchoLabel(
  mg: Pick<MessagingGroup, 'name' | 'platform_id' | 'is_group'>,
  senderName?: string | null,
): string {
  if (mg.is_group === 1) return `#${mg.name ?? mg.platform_id} room`;
  const who = mg.name ?? senderName;
  return who ? `DM with ${who}` : `DM (${mg.platform_id})`;
}

/** Human label for a same-mg sibling-thread echo — the target session is
 *  another conversation-thread of the very same DM, so the label reads as
 *  "another conversation with <who>" rather than naming a different surface. */
export function buildSiblingEchoLabel(
  mg: Pick<MessagingGroup, 'name' | 'platform_id' | 'is_group'>,
  senderName?: string | null,
): string {
  const who = mg.is_group === 0 ? (mg.name ?? senderName) : null;
  return who ? `another conversation with ${who}` : `another conversation in ${buildEchoLabel(mg, senderName)}`;
}

/** Label for an echo of a message the agent delivered INTO this conversation
 *  from elsewhere (a task run, or a cross-conversation send). Targets are
 *  always sessions of the very conversation the message landed in, so
 *  "this DM"/"this room" is accurate from every receiver's perspective. */
export function buildDeliveredEchoLabel(mg: Pick<MessagingGroup, 'is_group'>, fromTask: boolean): string {
  const where = mg.is_group === 1 ? 'this room' : 'this DM';
  return fromTask ? `${where}, posted by your scheduled task` : `${where}, posted by you from another conversation`;
}

export interface EchoTargetCandidate {
  id: string;
  status: string;
  messaging_group_id: string | null;
}

/**
 * Pure audience rule: only active sibling sessions of the conversation
 * the message appeared in. Same messaging group = identical audience, so the
 * rule needs no membership knowledge. Sessions with no messaging group (task
 * sessions, a2a targets) are never targets, and an unresolved source
 * conversation fans nowhere.
 */
export function selectEchoTargets<T extends EchoTargetCandidate>(
  candidates: T[],
  sourceSessionId: string,
  sourceMessagingGroupId: string | null,
): T[] {
  if (sourceMessagingGroupId === null) return [];
  return candidates.filter(
    (s) => s.id !== sourceSessionId && s.status === 'active' && s.messaging_group_id === sourceMessagingGroupId,
  );
}

function parseContent(raw: string): { text: string; sender: string | null; senderId: string | null } {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      text: typeof parsed.text === 'string' ? parsed.text : '',
      sender: typeof parsed.sender === 'string' ? parsed.sender : null,
      senderId: typeof parsed.senderId === 'string' ? parsed.senderId : null,
    };
  } catch {
    return { text: raw, sender: null, senderId: null };
  }
}

interface EchoFanInput {
  agentGroupId: string;
  sourceSessionId: string;
  /** Messaging group of the conversation the message appeared in — the ONLY
   *  conversation whose sessions are targets. */
  sourceMessagingGroupId: string | null;
  origMessageId: string;
  timestamp: string;
  surface: EchoWireSurface;
  label: string;
  platformId: string;
  text: string;
  sender: string;
  senderId: string | null;
}

async function fanEcho(input: EchoFanInput): Promise<number> {
  const candidates = await getSessionsByAgentGroup(input.agentGroupId);
  const targets = selectEchoTargets(candidates, input.sourceSessionId, input.sourceMessagingGroupId);
  if (targets.length === 0) return 0;

  const content = JSON.stringify({
    text: truncateEchoText(input.text),
    sender: input.sender,
    senderId: input.senderId,
    echo: { surface: input.surface, label: input.label },
  });

  let written = 0;
  for (const target of targets) {
    try {
      await writeSessionMessage(input.agentGroupId, target.id, {
        id: echoRowId(input.origMessageId, target.id),
        kind: 'chat',
        timestamp: input.timestamp,
        platformId: input.platformId,
        channelType: ECHO_CHANNEL_TYPE,
        threadId: null,
        content,
        trigger: false,
        sourceSessionId: input.sourceSessionId,
      });
      written++;
    } catch (err) {
      // Per-target isolation: one broken session DB (or a duplicate id from a
      // replay) must not stop the rest of the fan — or, upstream, routing.
      log.warn('Echo fan write failed', {
        targetSessionId: target.id,
        origMessageId: input.origMessageId,
        err,
      });
    }
  }
  return written;
}

/**
 * Router hook: fan a just-written trigger=1 inbound message into sibling
 * sessions. Call ONLY for the engaged (wake) branch — accumulate (trigger=0)
 * writes must never fan (D3). Never throws; returns rows written.
 */
export async function fanInboundMessage(args: {
  /** Source session the trigger=1 row was written to. */
  session: Session;
  /** Messaging group the message arrived on (the source surface). */
  mg: MessagingGroup;
  /** The id the source row was written with (post agent-group namespacing). */
  messageId: string;
  kind: string;
  /** channel_type as written on the source row. */
  channelType: string;
  content: string;
  timestamp: string;
}): Promise<number> {
  try {
    const { session, mg } = args;
    if (!CHAT_KINDS.has(args.kind)) return 0;
    // Only real chat surfaces fan: a2a rows and echo rows never re-fan.
    if (args.channelType === 'agent' || args.channelType === ECHO_CHANNEL_TYPE) return 0;
    // Task sessions are never a SOURCE (their traffic is series-internal).
    if (isTaskThread(session.thread_id)) return 0;
    const parsed = parseContent(args.content);
    if (!parsed.text) return 0;
    // Targets are always sibling threads of the conversation the message
    // arrived on, so every echo is sibling-flavored.
    return await fanEcho({
      agentGroupId: session.agent_group_id,
      sourceSessionId: session.id,
      sourceMessagingGroupId: mg.id,
      origMessageId: args.messageId,
      timestamp: args.timestamp,
      surface: ECHO_SIBLING_SURFACE,
      label: buildSiblingEchoLabel(mg, parsed.sender),
      platformId: mg.platform_id,
      text: parsed.text,
      sender: parsed.sender ?? 'unknown',
      senderId: parsed.senderId,
    });
  } catch (err) {
    log.warn('Inbound echo fan failed', { sessionId: args.session.id, err });
    return 0;
  }
}

/**
 * Delivery hook: fan the agent's own just-delivered user-facing message into
 * the sessions of the conversation it was delivered to. Caller applies the
 * user-facing predicate (kind not system/task_log, channel_type not 'agent');
 * the guards here are belt-and-braces so the contract holds even if call
 * sites drift. The delivered-to conversation resolves origin-session-first,
 * then own-destination-first, mirroring delivery.ts's resolution order —
 * needed so sibling-instance rows sharing one channel address resolve to the
 * sender's own row, not an arbitrary sibling's. Never throws.
 */
export async function fanOutboundMessage(
  msg: {
    id: string;
    kind: string;
    platform_id: string | null;
    channel_type: string | null;
    content: string;
  },
  session: Session,
  agentGroup: AgentGroup,
): Promise<number> {
  try {
    if (msg.kind === 'system' || msg.kind === 'task_log') return 0;
    if (!msg.channel_type || !msg.platform_id) return 0;
    if (msg.channel_type === 'agent' || msg.channel_type === ECHO_CHANNEL_TYPE) return 0;
    const isTaskSource = isTaskThread(session.thread_id);

    const originMg = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
    const mg =
      originMg && originMg.channel_type === msg.channel_type && originMg.platform_id === msg.platform_id
        ? originMg
        : ((await getMessagingGroupForOwnDestination(session.agent_group_id, msg.channel_type, msg.platform_id)) ??
          (await getMessagingGroupByPlatform(msg.channel_type, msg.platform_id)));
    if (!mg) return 0;

    const parsed = parseContent(msg.content);
    if (!parsed.text) return 0;
    // Targets are the sessions of the conversation the message was DELIVERED
    // to. An origin-conversation reply reads as a sibling-thread echo;
    // a message the agent posted INTO this conversation from elsewhere (a
    // task run, or a cross-conversation send) gets the delivered flavor.
    const isOriginSend = session.messaging_group_id === mg.id;
    return await fanEcho({
      agentGroupId: session.agent_group_id,
      sourceSessionId: session.id,
      sourceMessagingGroupId: mg.id,
      origMessageId: msg.id,
      timestamp: new Date().toISOString(),
      surface: isTaskSource ? ECHO_TASK_SURFACE : ECHO_SIBLING_SURFACE,
      label:
        !isTaskSource && isOriginSend ? buildSiblingEchoLabel(mg, mg.name) : buildDeliveredEchoLabel(mg, isTaskSource),
      platformId: mg.platform_id,
      text: parsed.text,
      sender: agentGroup.name,
      senderId: agentGroup.id,
    });
  } catch (err) {
    log.warn('Outbound echo fan failed', { sessionId: session.id, messageId: msg.id, err });
    return 0;
  }
}
