/**
 * Cross-session context — accumulate fan-out.
 *
 * Copies triggering user messages (router hook) and the agent's own delivered
 * user-facing messages (delivery hook) into sibling sessions of the same
 * conversation as trigger=0 rows with channel_type 'session-echo'. Echo rows
 * ride along as ambient context with the next real trigger — they never wake
 * a container, never provide reply routing (thread_id NULL; the formatter's
 * reply-routing extraction skips 'session-echo'), and are never themselves
 * fanned (loop guard: fan entries reject 'session-echo' rows, and echo writes
 * go straight to the target mailbox, never through routeInbound).
 *
 * Audience rule: a message fans ONLY into sibling sessions of the
 * conversation it actually appeared in — for inbound, the messaging group it
 * arrived on; for outbound, the messaging group it was delivered to. Same
 * messaging group = identical audience by definition, so every fan is
 * provably audience-safe with no membership knowledge needed. Nothing else is
 * ever a target: not the group's other conversations, not task sessions
 * (task sessions have no messaging group). Cross-conversation awareness is
 * pull-only: `ncl sessions history`. Task sessions are never an inbound
 * SOURCE (the series prompt is series-internal); a task's DELIVERED
 * user-facing send fans like any other delivery.
 *
 * Bound: within that audience, only the HOT SET receives live echoes — the
 * conversation's HOT_SESSION_LIMIT most recently active sessions (within
 * ECHO_MAX_AGE_DAYS) plus its top-level session. A session outside the hot
 * set catches up from the hot set when it next wakes (backfill.ts). Ranking
 * is by `sessions.last_active`, which only REAL inbound messages bump — echo
 * writes deliberately bypass writeSessionMessage so ambient traffic never
 * makes an idle thread look busy.
 *
 * Cost: the fan is off the message's critical path (callers fire it after
 * the wake, unawaited), does one bounded central read, and writes its ≤ K+1
 * targets concurrently through the lean path (existing mailbox only — no
 * provisioning, no last_active bump, no reconcile enqueue). Never throws.
 */
import {
  getMessagingGroup,
  getMessagingGroupByPlatform,
  getMessagingGroupForOwnDestination,
} from '../../db/messaging-groups.js';
import { findSessionForAgent, getRecentConversationSessions, isTaskThread } from '../../db/sessions.js';
import { log } from '../../log.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import type { AgentGroup, MessagingGroup, Session } from '../../types.js';
import {
  ECHO_CHANNEL_TYPE,
  ECHO_CONCURRENCY,
  ECHO_MAX_AGE_MS,
  ECHO_SIBLING_SURFACE,
  ECHO_TASK_SURFACE,
  ECHO_TEXT_MAX_CHARS,
  HOT_SESSION_LIMIT,
} from './config.js';
import { mapConcurrent } from './parallel.js';

/** Surface values that appear on the wire in echo.{surface}: the sibling-
 *  thread marker and the task-delivery marker (backfill's timeline surfaces
 *  are written by backfill.ts directly). Every fan target is a session of the
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

/** Human label for the source conversation, e.g. '#Pixel room' / 'DM with Alex'. */
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
  thread_id: string | null;
  last_active: string | null;
}

function activeAt(session: EchoTargetCandidate): number {
  return session.last_active === null ? Number.NaN : Date.parse(session.last_active);
}

/**
 * Pure hot-set rule (see header): the conversation's HOT_SESSION_LIMIT most
 * recently active sessions within ECHO_MAX_AGE_MS, plus its top-level session
 * when that is active in the window — a thread is usually a reply to
 * something said at the top level, so it must stay in view. Closed sessions,
 * sessions of other conversations, sessions with no messaging group (task,
 * a2a), and sessions that never received a message are never hot. Dedupes by
 * id, so callers may pass overlapping candidate lists; an unresolved
 * conversation has no hot set.
 */
export function selectHotSessions<T extends EchoTargetCandidate>(
  candidates: readonly T[],
  messagingGroupId: string | null,
  nowMs: number = Date.now(),
): T[] {
  if (messagingGroupId === null) return [];
  const cutoff = nowMs - ECHO_MAX_AGE_MS;
  const seen = new Set<string>();
  const eligible = candidates.filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    const at = activeAt(s);
    return s.status === 'active' && s.messaging_group_id === messagingGroupId && Number.isFinite(at) && at >= cutoff;
  });
  eligible.sort((a, b) => activeAt(b) - activeAt(a));
  const hot = eligible.slice(0, HOT_SESSION_LIMIT);
  const topLevel = eligible.find((s) => s.thread_id === null);
  if (topLevel && !hot.includes(topLevel)) hot.push(topLevel);
  return hot;
}

/**
 * Fan audience: the hot set of the conversation's OTHER sessions — the source
 * never counts against the K slots, so up to K siblings (+ top-level) hear a
 * message whether or not the source is itself hot.
 */
export function selectEchoTargets<T extends EchoTargetCandidate>(
  candidates: readonly T[],
  sourceSessionId: string,
  sourceMessagingGroupId: string | null,
  nowMs: number = Date.now(),
): T[] {
  return selectHotSessions(
    candidates.filter((s) => s.id !== sourceSessionId),
    sourceMessagingGroupId,
    nowMs,
  );
}

/**
 * Load the hot-set candidates from the central DB: one bounded query for the
 * K+1 most recently active sessions (one spare so excluding any single
 * session still leaves a full K) plus the top-level lookup, issued together.
 * K+2 rows at most, however many sessions the channel has. Feed the result to
 * selectHotSessions / selectEchoTargets.
 */
export async function loadHotCandidates(
  agentGroupId: string,
  messagingGroupId: string,
  nowMs: number = Date.now(),
): Promise<Session[]> {
  const sinceIso = new Date(nowMs - ECHO_MAX_AGE_MS).toISOString();
  const [recent, topLevel] = await Promise.all([
    getRecentConversationSessions(agentGroupId, messagingGroupId, sinceIso, HOT_SESSION_LIMIT + 1),
    findSessionForAgent(agentGroupId, messagingGroupId, null),
  ]);
  return topLevel ? [...recent, topLevel] : recent;
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

/**
 * Lean echo write: straight into an EXISTING target mailbox. Deliberately not
 * writeSessionMessage — that path provisions the folder, extracts
 * attachments, bumps last_active (which would make every idle thread look
 * busy) and enqueues a reconcile (pointless: trigger=0 rows never wake).
 * A target whose mailbox is gone (operator reset) is skipped; its next real
 * message re-provisions it.
 */
async function writeEcho(input: EchoFanInput, targetSessionId: string, content: string): Promise<boolean> {
  const landed = await withExistingMailboxSession(input.agentGroupId, targetSessionId, async (mailbox) => {
    await mailbox.insertMessage({
      id: echoRowId(input.origMessageId, targetSessionId),
      kind: 'chat',
      timestamp: input.timestamp,
      platformId: input.platformId,
      channelType: ECHO_CHANNEL_TYPE,
      threadId: null,
      content,
      processAfter: null,
      recurrence: null,
      trigger: false,
      sourceSessionId: input.sourceSessionId,
      onWake: false,
    });
    return true;
  });
  return landed === true;
}

async function fanEcho(input: EchoFanInput): Promise<number> {
  if (input.sourceMessagingGroupId === null) return 0;
  const candidates = await loadHotCandidates(input.agentGroupId, input.sourceMessagingGroupId);
  const targets = selectEchoTargets(candidates, input.sourceSessionId, input.sourceMessagingGroupId);
  if (targets.length === 0) return 0;

  const content = JSON.stringify({
    text: truncateEchoText(input.text),
    sender: input.sender,
    senderId: input.senderId,
    echo: { surface: input.surface, label: input.label },
  });

  const results = await mapConcurrent(targets, ECHO_CONCURRENCY, (target) => writeEcho(input, target.id, content));
  let written = 0;
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      if (result.value) written++;
      return;
    }
    // Per-target isolation: one broken session mailbox (or a duplicate id
    // from a replay) must not stop the rest of the fan.
    log.warn('Echo fan write failed', {
      targetSessionId: targets[i].id,
      origMessageId: input.origMessageId,
      err: result.reason,
    });
  });
  return written;
}

// ── In-flight tracking ──
//
// Callers fire fans unawaited (after the wake / between deliveries). Track
// them so tests and a graceful shutdown can wait for the tail.

const inFlight = new Set<Promise<number>>();

function track(fan: Promise<number>): Promise<number> {
  inFlight.add(fan);
  const done = () => inFlight.delete(fan);
  fan.then(done, done);
  return fan;
}

/** Resolve once every fan currently in flight has settled. */
export async function settleEchoFans(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

/**
 * Router hook: fan a just-written trigger=1 inbound message into sibling
 * sessions. Call ONLY for the engaged (wake) branch — accumulate (trigger=0)
 * writes must never fan (D3). Never throws; resolves to rows written. Safe
 * to leave unawaited (see settleEchoFans).
 */
export function fanInboundMessage(args: {
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
  return track(fanInbound(args));
}

async function fanInbound(args: Parameters<typeof fanInboundMessage>[0]): Promise<number> {
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
 * sender's own row, not an arbitrary sibling's. Never throws. Safe to leave
 * unawaited (see settleEchoFans).
 */
export function fanOutboundMessage(
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
  return track(fanOutbound(msg, session, agentGroup));
}

async function fanOutbound(
  msg: Parameters<typeof fanOutboundMessage>[0],
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
