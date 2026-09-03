/**
 * The Slack leg of create_agent — steps S1–S13 (one typed step id each).
 *
 * Ordering is load-bearing:
 *  - S1/S2 are local/cheap prechecks — nothing external is created until the
 *    operator identity and the origin bot token both resolve.
 *  - S10 (SLACK_A2A_ROOMS append) runs strictly BEFORE the origin agent is
 *    nudged to post the room intro, so every sibling instance's a2a
 *    bridge admits the bot-authored intro instead of dropping it as a bot
 *    sender.
 *  - S13's DM intro and the origin intro nudge are gated on rows newly
 *    created in S8/S11 — a retry (finish script) never double-posts or
 *    double-nudges.
 * Every step is idempotent: provision reuses .env tokens, messaging groups
 * and wirings are get-before-create, conversations.open is idempotent on
 * Slack's side.
 *
 * Slack HTTP plumbing comes from the shared channel-layer lib
 * (src/channels/slack-lib.ts, installed with the Slack channel payload);
 * access to the skill-installed adapter modules goes through
 * loadSlackChannelDeps() so a partial install fails as a typed step error.
 */
import {
  resolveUnknownSenderPolicy,
  resolveWiringDefaults,
  validateEngageAgainstChannel,
} from '../../channels/channel-defaults.js';
import {
  SlackApiError,
  botTokenKeyForInstance,
  slackAuthTest,
  slackConversationsOpen,
  slackPostMessage,
} from '../../channels/slack-lib.js';
import { projectDestinationsToSessions } from '../../cli/resources/destinations.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getAllMessagingGroups,
  getMessagingGroup,
  getMessagingGroupAgentByPair,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
} from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import type { MessagingGroup, MessagingGroupAgent, Session } from '../../types.js';
import {
  createDestination,
  getDestinationByName,
  getDestinationByTarget,
  normalizeName,
} from '../agent-to-agent/db/agent-destinations.js';
import { notifyAgent, pickApprover } from '../approvals/primitive.js';
import { appendToEnvList, readEnvValue } from './env-file.js';
import { provisionSlackApp } from './provision.js';
import { createRoomCanvas, wireCanvasComments } from './room-canvas.js';
import { assertSlackInstancesModuleInstalled, loadSlackChannelDeps } from './slack-deps.js';
import { SlackFlowError, type OrchestrateSuccess, type SlackFlowStep } from './types.js';

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function envSuffix(slug: string): string {
  return slug.toUpperCase().replace(/-/g, '_');
}

/** Wrap a non-typed failure with the step it happened in. Never carries token
 *  values. A SlackApiError keeps its own step — the shared Slack lib
 *  (src/channels/slack-lib.ts) tags each call with the flow step id the call
 *  site passed, which is more precise than the enclosing wrapper's step. */
function asFlowError(err: unknown, step: SlackFlowStep): SlackFlowError {
  if (err instanceof SlackFlowError) return err;
  if (err instanceof SlackApiError) return new SlackFlowError(err.step as SlackFlowStep, err.message);
  return new SlackFlowError(step, err instanceof Error ? err.message : String(err));
}

/** One canonical slugger — the same normalizeName the a2a destination namespace uses. */
export function deriveInstanceSlug(name: string): string {
  return normalizeName(name);
}

/**
 * First approver with a Slack identity, 'slack:' prefix stripped. pickApprover
 * order (scoped admins → global admins → owners) picks who gets the DM.
 */
export async function resolveOperatorSlackUserId(sourceAgentGroupId: string): Promise<string | null> {
  const hit = (await pickApprover(sourceAgentGroupId)).find((id) => /^slack:U/i.test(id));
  return hit ? hit.slice('slack:'.length) : null;
}

/**
 * A slug conflicts when its .env footprint is already claimed (token key set
 * or slug listed in SLACK_INSTANCES) AND its `slack-<slug>` instance is wired
 * to a DIFFERENT agent group. Claimed-but-wired-to-this-group (or to nothing)
 * is the retry path — reuse.
 */
async function slugConflicts(slug: string, newAgentGroupId: string, rootDir: string): Promise<boolean> {
  const tokenExists = readEnvValue(rootDir, `SLACK_BOT_TOKEN_${envSuffix(slug)}`) !== undefined;
  const instances = (readEnvValue(rootDir, 'SLACK_INSTANCES') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!tokenExists && !instances.includes(slug)) return false;

  const instanceKey = `slack-${slug}`;
  for (const mg of await getAllMessagingGroups()) {
    if (mg.instance !== instanceKey) continue;
    for (const wiring of await getMessagingGroupAgents(mg.id)) {
      if (wiring.agent_group_id !== newAgentGroupId) return true;
    }
  }
  return false;
}

export async function dedupeSlug(
  base: string,
  newAgentGroupId: string,
  rootDir: string = process.cwd(),
): Promise<string> {
  let slug = base;
  for (let n = 2; await slugConflicts(slug, newAgentGroupId, rootDir); n++) slug = `${base}-${n}`;
  return slug;
}

async function ensureMessagingGroupRow(spec: {
  platformId: string;
  instance: string;
  name: string;
  isGroup: boolean;
  unknownSenderPolicy: MessagingGroup['unknown_sender_policy'];
}): Promise<{ mg: MessagingGroup; created: boolean }> {
  const existing = await getMessagingGroupByPlatform('slack', spec.platformId, spec.instance);
  if (existing) return { mg: existing, created: false };
  const mg: MessagingGroup = {
    id: generateId('mg'),
    channel_type: 'slack',
    platform_id: spec.platformId,
    instance: spec.instance,
    name: spec.name,
    is_group: spec.isGroup ? 1 : 0,
    unknown_sender_policy: spec.unknownSenderPolicy,
    created_at: new Date().toISOString(),
  };
  await createMessagingGroup(mg);
  return { mg, created: true };
}

/** Flow-chosen deviations from the channel-declared wiring defaults. */
interface WiringOverrides {
  /** Set together with engage_pattern to bypass resolveWiringDefaults. */
  engage_mode?: MessagingGroupAgent['engage_mode'];
  engage_pattern?: string | null;
  ignored_message_policy?: MessagingGroupAgent['ignored_message_policy'];
  session_mode?: MessagingGroupAgent['session_mode'];
  /** 1/0 explicit stamp; null = explicitly leave the column NULL (inherit the
   *  channel declaration at fanout time); omitted = follow the derived
   *  creation-time stamp (resolveWiringDefaults stamps threads=1 when the
   *  declared sessionMode is 'per-thread', else null). */
  threads?: number | null;
}

/** Get-before-create wiring with channel-declared defaults (engage fields,
 *  plus the B7 session-mode/threads creation-time stamps) unless overridden.
 *  True iff newly created. */
async function ensureWiring(
  mg: MessagingGroup,
  agentGroupId: string,
  agentGroupName: string,
  overrides: WiringOverrides = {},
): Promise<boolean> {
  if (await getMessagingGroupAgentByPair(mg.id, agentGroupId)) return false;
  const channelKey = mg.instance ?? mg.channel_type;
  // Overriding engage_mode bypasses the declaration entirely (flow-owned
  // room semantics, D4); declaration-resolved wirings take the declared
  // session_mode / threads stamps too (B7).
  const resolved =
    overrides.engage_mode !== undefined
      ? undefined
      : resolveWiringDefaults(channelKey, mg.is_group === 1, agentGroupName, mg.channel_type);
  const engage = resolved ?? { engage_mode: overrides.engage_mode!, engage_pattern: overrides.engage_pattern ?? null };
  const threads = overrides.threads !== undefined ? overrides.threads : (resolved?.threads ?? null);
  const wiring: MessagingGroupAgent = {
    id: generateId('mga'),
    messaging_group_id: mg.id,
    agent_group_id: agentGroupId,
    engage_mode: engage.engage_mode,
    engage_pattern: engage.engage_pattern,
    sender_scope: 'all',
    ignored_message_policy: overrides.ignored_message_policy ?? 'drop',
    session_mode: overrides.session_mode ?? resolved?.session_mode ?? 'shared',
    priority: 0,
    ...(threads !== null ? { threads } : {}),
    created_at: new Date().toISOString(),
  };
  validateEngageAgainstChannel(wiring, mg);
  // createMessagingGroupAgent persists an explicit `threads` value itself
  // (follow-up UPDATE in src/db/messaging-groups.ts) — the declared threads:1 stamp lands.
  await createMessagingGroupAgent(wiring);
  return true;
}

/**
 * Room-wiring semantics for flow-created rooms (D4): each bot speaks only
 * when @-mentioned; everything else accumulates as ambient context delivered
 * with the next mention. Deliberately NOT the channel group default —
 * flow-created rooms only.
 */
const ROOM_WIRING_OVERRIDES: WiringOverrides = {
  engage_mode: 'mention',
  engage_pattern: null,
  ignored_message_policy: 'accumulate',
};

/** One bot in a shared room: its adapter instance and the agent group behind it. */
export interface RoomParticipant {
  /** Adapter-instance key ('slack' or 'slack-<slug>'). */
  instanceKey: string;
  botUserId: string;
  agentGroupId: string;
  agentGroupName: string;
}

/**
 * Idempotent agent→agent destination (= ACL grant + local name). No-op when
 * a destination for the target already exists under any name (upstream
 * create_agent's parent/child rows count). Name collisions get a numeric
 * suffix, mirroring ensureAgentDestinationForWiring.
 */
async function ensureAgentDestination(fromGroupId: string, toGroupId: string, toName: string): Promise<void> {
  if (fromGroupId === toGroupId) return;
  if (await getDestinationByTarget(fromGroupId, 'agent', toGroupId)) return;
  const base = normalizeName(toName) || toGroupId.slice(0, 8);
  let localName = base;
  let suffix = 2;
  while (await getDestinationByName(fromGroupId, localName)) {
    localName = `${base}-${suffix}`;
    suffix++;
  }
  await createDestination({
    agent_group_id: fromGroupId,
    local_name: localName,
    target_type: 'agent',
    target_id: toGroupId,
    created_at: new Date().toISOString(),
  });
}

/** Full pairwise a2a destination symmetry between every distinct agent group
 *  in the room — "ask Devin" must be actionable from any participant. */
async function ensurePairwiseAgentDestinations(participants: RoomParticipant[]): Promise<void> {
  for (const a of participants) {
    for (const b of participants) {
      if (a.agentGroupId === b.agentGroupId) continue;
      await ensureAgentDestination(a.agentGroupId, b.agentGroupId, b.agentGroupName);
    }
  }
}

/**
 * Public purpose: ONLY the explicitly provided line (capped 80). No fallback
 * from the instructions — the creation prompt is the agent's private persona
 * and never appears on shared surfaces. No purpose = the intro simply
 * doesn't state one.
 */
export function publicPurpose(explicit: string | undefined): string | undefined {
  const cleaned = explicit?.trim();
  if (!cleaned) return undefined;
  return cleaned.length <= 80 ? cleaned : `${cleaned.slice(0, 80)}…`;
}

/**
 * The ORIGIN agent — not a host template — introduces the new agent
 * in the shared room. This is the instruction the origin session wakes to;
 * the intro itself stays in the agent's own voice, and the room-contract
 * data (purpose, members, created date) lives on the canvas, not in chat.
 */
function roomIntroNudgeText(args: {
  newAgentName: string;
  newBotUserId: string;
  roomName: string;
  /** The origin agent's local destination name for the room. */
  roomDestination: string;
  purpose?: string;
}): string {
  return (
    `A shared Slack room "${args.roomName}" was just opened with you, the operator, and your new agent ${args.newAgentName}` +
    `${args.purpose ? ` (${args.purpose})` : ''}. ` +
    `Post a brief introduction of ${args.newAgentName} there now via send_message({ to: "${args.roomDestination}", ... }): ` +
    `1-2 lines in your own voice saying what they're for, tagging them with <@${args.newBotUserId}> ` +
    `(include that literally — it renders as a mention). Just the intro — no mechanics, no member lists.`
  );
}

/**
 * N-bot-capable room step (S9–S13's room half): open the MPIM as `creator`
 * with the operator + every participating bot, allowlist it for a2a, create
 * one mg row + mention/accumulate wiring PER participating instance, ensure
 * pairwise a2a destinations, then (only when rows were newly created) create
 * the room canvas — the room's pinned contract surface (no contract
 * message, no link post; the channel canvas is already the room's canvas
 * tab) — and wire its comment shadow channel for every participant. The
 * conversational create_agent flow calls this with the 3-way default; any
 * caller may pass a larger participant list.
 */
export async function ensureAgentRoom(args: {
  /** Bot that opens the MPIM and creates the canvas. Must be one of `participants`. */
  creator: RoomParticipant;
  creatorBotToken: string;
  operatorUserId: string;
  /** All bots in the room, creator included. */
  participants: RoomParticipant[];
  /** Additional member user ids beyond the operator + participating bots —
   *  e.g. Slack-UI-added humans carried over when add_to_room forks a room.
   *  Members only; they get no mg rows or wirings. */
  extraMemberUserIds?: string[];
  roomName: string;
  /** Creation prompt (room purpose) — the canvas contract excerpt. */
  purpose?: string;
  rootDir: string;
}): Promise<{ roomChannelId: string; created: boolean }> {
  const { creator, creatorBotToken, operatorUserId, participants, rootDir } = args;

  // S9 mpim-open — operator + carried extra members + every other
  // participating bot, opened AS the creator.
  const otherBotIds = participants.filter((p) => p.botUserId !== creator.botUserId).map((p) => p.botUserId);
  const roomChannelId = await slackConversationsOpen(
    creatorBotToken,
    [operatorUserId, ...(args.extraMemberUserIds ?? []), ...otherBotIds],
    'mpim-open',
  );

  // S10 a2a-env — strictly before the origin agent can be nudged to post its
  // intro: every sibling instance's a2a bridge must already allow the room
  // or it drops bot-authored posts.
  try {
    appendToEnvList(rootDir, 'SLACK_A2A_ROOMS', roomChannelId);
  } catch (err) {
    throw asFlowError(err, 'a2a-env');
  }

  // S11 room-wire — one row PER participating instance (router lookup is
  // exact-on-instance). unknown_sender_policy 'public' explicitly: sibling
  // bridges' access gates must never approval-spam admitted bot messages.
  // Wirings are mention/accumulate (D4 — flow-created rooms only).
  let created = false;
  try {
    for (const p of participants) {
      const row = await ensureMessagingGroupRow({
        platformId: `slack:${roomChannelId}`,
        instance: p.instanceKey,
        name: args.roomName,
        isGroup: true,
        unknownSenderPolicy: 'public',
      });
      await ensureWiring(row.mg, p.agentGroupId, p.agentGroupName, ROOM_WIRING_OVERRIDES);
      created = row.created || created;
    }
    await ensurePairwiseAgentDestinations(participants);
  } catch (err) {
    throw asFlowError(err, 'room-wire');
  }

  // S12 projections — in-host-process, so already-running containers see the
  // auto-created destinations without waiting for the next spawn.
  for (const groupId of new Set(participants.map((p) => p.agentGroupId))) {
    await projectDestinationsToSessions(groupId);
  }

  // S13 room half — gated on newly created rows so a retry never grows a
  // second canvas. No room-contract message: the canvas tab is the
  // pinned surface and carries the contract data; the intro is authored by
  // the ORIGIN agent (nudged by runFlow). Canvas failure is non-fatal
  // (C2: createRoomCanvas never throws) — no canvas, no shadow channel.
  if (created) {
    const canvasId = await createRoomCanvas(creatorBotToken, roomChannelId, {
      roomName: args.roomName,
      purpose: args.purpose ?? args.roomName,
      creatorUserId: operatorUserId,
      agentNames: participants.map((p) => p.agentGroupName),
    });
    // Canvas comments arrive in a Slackbot-owned shadow channel (canvas id
    // with F→C) — wire EVERY participating instance: creator as the
    // pattern-engage default responder, siblings mention/accumulate.
    // Non-throwing; no canvas id, nothing to wire.
    if (canvasId) await wireCanvasComments(canvasId, creator, participants, args.roomName);
  }

  return { roomChannelId, created };
}

/**
 * How long the flow waits inline for a workspace install approval, and how
 * often it checks. The default is five minutes at a five-second cadence —
 * long enough for someone already at their desk, short enough that the app
 * parks (and stays resumable) rather than holding this session's delivery
 * open indefinitely.
 *
 * `SLACK_INSTALL_WAIT_MS=0` skips the wait entirely: installs that always go
 * through a slow approval queue are better served by parking immediately and
 * finishing on a later ask. `SLACK_INSTALL_POLL_MS` moves the cadence.
 */
function resolveInstallWait(rootDir: string): { intervalMs?: number; timeoutMs?: number } | undefined {
  const num = (key: string): number | undefined => {
    const raw = readEnvValue(rootDir, key);
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  const timeoutMs = num('SLACK_INSTALL_WAIT_MS');
  const intervalMs = num('SLACK_INSTALL_POLL_MS');
  if (timeoutMs === undefined && intervalMs === undefined) return undefined;
  return { ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(intervalMs !== undefined ? { intervalMs } : {}) };
}

/**
 * The one line the human gets while the flow waits on a workspace install
 * approval. Short on purpose: the link is the only actionable part, and the
 * flow says nothing else until it either finishes or parks.
 */
export function installPendingText(displayName: string, info: { installUrl?: string; resumed: boolean }): string {
  const where = info.installUrl ? ` Approve it here: ${info.installUrl}` : '';
  return info.resumed
    ? `Still waiting on your workspace to approve installing ${displayName}.${where} — I'll finish setting it up as soon as that lands.`
    : `${displayName} is created, but your workspace needs an admin to approve installing it.${where} — I'll finish the setup automatically once it's approved.`;
}

interface FlowArgs {
  slug: string;
  displayName: string;
  sourceGroupId: string;
  newAgentGroupId: string;
  originInstanceKey: string;
  /** Slack channel the create was asked for in — where the flow talks back
   *  while it waits. Absent on the out-of-process finish path, which prints
   *  to the operator's terminal instead. */
  originChannelId?: string;
  rootDir: string;
  /** false on the out-of-process finish path — S5 needs the live host's registry. */
  hotStart: boolean;
  /** Agent instructions excerpt — drives the broker-generated avatar. */
  description?: string;
  /** Short PUBLIC line for the room contract + canvas ("what this agent is
   *  for"). Falls back to a first-sentence excerpt of the instructions —
   *  never the full creation prompt (it may carry private detail). */
  purpose?: string;
  /** true → plain manifest variant (guest-visible); false/absent → agent_view. */
  allowGuests?: boolean;
  /** The session whose create_agent call started the flow — receives the
   *  room-intro nudge. Absent on the out-of-process finish path. */
  originSession?: Session;
  /**
   * Room policy: 'own' (default) opens the shared origin+operator
   * room; 'none' skips the room half entirely — the multi-create pattern is
   * N creates with room:'none' followed by one create_room with all of them.
   */
  room?: 'own' | 'none';
  /** Wait budget for a deferred workspace install. Tests shorten it. */
  installWait?: { intervalMs?: number; timeoutMs?: number };
  /** Extra sink for the pending-install line — the finish script prints it to
   *  the operator's terminal, which has no Slack conversation to post into. */
  onInstallPending?: (text: string) => void;
}

async function runFlow(args: FlowArgs): Promise<OrchestrateSuccess> {
  const { slug, displayName, sourceGroupId, newAgentGroupId, originInstanceKey, rootDir } = args;
  const instanceKey = `slack-${slug}`;

  // S1 operator-identity
  const operatorUserId = await resolveOperatorSlackUserId(sourceGroupId);
  if (!operatorUserId) {
    throw new SlackFlowError(
      'operator-identity',
      'no approver with a Slack identity (slack:U…) found in user_roles — grant one with `ncl roles grant` and retry',
    );
  }

  // S2 origin-auth — prove the origin instance's token before provisioning anything.
  const originTokenKey = botTokenKeyForInstance(originInstanceKey);
  const originBotToken = readEnvValue(rootDir, originTokenKey);
  if (!originBotToken) {
    throw new SlackFlowError(
      'origin-auth',
      `missing ${originTokenKey} in .env for origin instance '${originInstanceKey}'`,
    );
  }
  const originAuth = await slackAuthTest(originBotToken, 'origin-auth');
  const originBotUserId = originAuth.userId;

  // S3/S4 provision. A workspace that requires an admin to approve installs
  // refuses auto-install, and provisionSlackApp then waits for the human to
  // finish it in the browser. That wait is silent from the outside, so it
  // announces itself HERE, as the origin bot, in the conversation the create
  // was asked for — the origin agent cannot relay it, since its own replies
  // cannot be delivered while this handler is still running. A failed
  // announcement is not worth abandoning the wait for.
  const app = await provisionSlackApp({
    slug,
    displayName,
    rootDir,
    teamId: originAuth.teamId,
    description: args.description,
    allowGuests: args.allowGuests,
    requestedBy: operatorUserId,
    installWait: args.installWait ?? resolveInstallWait(rootDir),
    onInstallPending: async (info) => {
      const text = installPendingText(displayName, info);
      log.info('Waiting on a Slack workspace install approval', { step: 'install-wait', appId: info.appId });
      args.onInstallPending?.(text);
      if (!args.originChannelId) return;
      try {
        await slackPostMessage(originBotToken, args.originChannelId, text, 'install-wait');
      } catch (err) {
        log.warn('Could not announce the pending Slack install', {
          step: 'install-wait',
          err: err instanceof Error ? err.message : String(err),
        });
      }
    },
  });

  // S5 adapter-start. The multi-instance module must be installed regardless
  // of hotStart: S6-S8 below wire DB rows to an instance name the runtime
  // needs to be able to start after a restart, so the out-of-process finish
  // path (hotStart: false) checks this too instead of silently skipping
  // straight to DB writes for an instance nothing can ever connect.
  await assertSlackInstancesModuleInstalled();
  if (args.hotStart) {
    // Hot-add the new instance into the live registry.
    const deps = await loadSlackChannelDeps();
    deps.registerChannelAdapter(instanceKey, {
      factory: () => deps.slackInstanceBridgeFactory(slug),
      defaults: deps.SLACK_DEFAULTS,
    });
    let started: 'started' | 'already-active' | 'no-credentials';
    try {
      started = await deps.startChannelAdapter(instanceKey);
    } catch (err) {
      throw asFlowError(err, 'adapter-start');
    }
    // 'already-active' is the retry path — the instance survived a previous attempt.
    if (started === 'no-credentials') {
      throw new SlackFlowError(
        'adapter-start',
        `adapter '${instanceKey}' found no credentials in .env (SLACK_BOT_TOKEN_${app.envSuffix} / SLACK_APP_TOKEN_${app.envSuffix})`,
      );
    }
  }

  // S6 new-bot identity (auth.test gates the DM open — same step id).
  const newBotUserId = (await slackAuthTest(app.botToken, 'dm-open')).userId;

  // S7 dm-open — the operator DM, opened AS the new bot.
  const dmChannelId = await slackConversationsOpen(app.botToken, [operatorUserId], 'dm-open');

  // S8 dm-wire. Agent-view apps (the default variant, allowGuests !== true)
  // get thread-per-conversation DMs from the CHANNEL DECLARATION: the
  // Slack adapter's SLACK_DEFAULTS declares dm.sessionMode 'per-thread',
  // resolveWiringDefaults derives the threads=1 stamp from it (per-thread
  // sessions structurally require honored thread ids), and ensureWiring
  // stamps whatever it resolves — nothing is hardcoded here. The plain
  // (allow_guests) variant has no agent-mode DM surface, so it pins
  // session_mode 'shared' and leaves the threads column NULL explicitly.
  let dmCreated = false;
  try {
    const dmRow = await ensureMessagingGroupRow({
      platformId: `slack:${dmChannelId}`,
      instance: instanceKey,
      name: `${displayName} DM`,
      isGroup: false,
      unknownSenderPolicy: resolveUnknownSenderPolicy(instanceKey, false, 'slack'),
    });
    dmCreated = dmRow.created;
    const agentView = args.allowGuests !== true;
    await ensureWiring(
      dmRow.mg,
      newAgentGroupId,
      displayName,
      agentView ? {} : { session_mode: 'shared', threads: null },
    );
  } catch (err) {
    throw asFlowError(err, 'dm-wire');
  }

  // S9–S13 room half: MPIM + allowlist + per-instance mention/accumulate
  // wirings + pairwise destinations + canvas + room-contract intro. The
  // conversational flow's 3-way default; ensureAgentRoom itself is N-capable.
  // room:'none' skips the whole half — the DM is the entire surface
  // and the caller composes a shared room later via create_room.
  let roomChannelId: string | undefined;
  if (args.room !== 'none') {
    const sourceGroupName = (await getAgentGroup(sourceGroupId))?.name ?? sourceGroupId;
    const newParticipant: RoomParticipant = {
      instanceKey,
      botUserId: newBotUserId,
      agentGroupId: newAgentGroupId,
      agentGroupName: displayName,
    };
    const roomName = `${displayName} room`;
    const roomPurpose = publicPurpose(args.purpose);
    const room = await ensureAgentRoom({
      creator: newParticipant,
      creatorBotToken: app.botToken,
      operatorUserId,
      participants: [
        {
          instanceKey: originInstanceKey,
          botUserId: originBotUserId,
          agentGroupId: sourceGroupId,
          agentGroupName: sourceGroupName,
        },
        newParticipant,
      ],
      roomName,
      purpose: roomPurpose,
      rootDir,
    });
    roomChannelId = room.roomChannelId;

    // The ORIGIN agent authors the room intro — an instruction-shaped
    // system nudge (trigger=1 wake via notifyAgent) into the origin session,
    // gated on the S13 created-gate so a flow retry never double-nudges. The
    // wizard first-agent path never reaches here (it opens no room); the
    // out-of-process finish path has no origin session to nudge. The room
    // destination was projected into the live session in S12.
    if (room.created && args.originSession) {
      const roomMg = await getMessagingGroupByPlatform('slack', `slack:${roomChannelId}`, originInstanceKey);
      const roomDest = roomMg ? await getDestinationByTarget(sourceGroupId, 'channel', roomMg.id) : undefined;
      await notifyAgent(
        args.originSession,
        roomIntroNudgeText({
          newAgentName: displayName,
          newBotUserId,
          roomName,
          roomDestination: roomDest?.local_name ?? normalizeName(roomName),
          purpose: roomPurpose,
        }),
      );
    }
  }

  // S13 DM half — gated on the row newly created in S8.
  if (dmCreated) {
    await slackPostMessage(
      app.botToken,
      dmChannelId,
      `Hi <@${operatorUserId}> — I'm ${displayName}, your new agent. This DM is already wired up; just reply here to start.`,
      'intro-post',
    );
  }

  return {
    slug,
    newBotUserId,
    operatorUserId,
    dmChannelId,
    roomChannelId,
    ...(app.deferredInstall ? { deferredInstall: true } : {}),
  };
}

/** In-host entry — the wrapped create_agent handler's Slack leg (hot-add active). */
export async function runSlackAgentFlow(args: {
  content: Record<string, unknown>;
  session: Session;
  newAgentGroupId: string;
  slug: string;
  /** Wait budget for a deferred workspace install. Tests shorten it. */
  installWait?: { intervalMs?: number; timeoutMs?: number };
}): Promise<OrchestrateSuccess> {
  const { content, session, newAgentGroupId, slug } = args;
  const displayName =
    typeof content.name === 'string' && content.name
      ? content.name
      : ((await getAgentGroup(newAgentGroupId))?.name ?? slug);
  const originMg = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
  return runFlow({
    slug,
    displayName,
    sourceGroupId: session.agent_group_id,
    newAgentGroupId,
    originInstanceKey: originMg?.instance ?? 'slack',
    // messaging_groups store 'slack:<channelId>'; the Web API wants the bare id.
    originChannelId: originMg?.platform_id?.replace(/^slack:/, ''),
    installWait: args.installWait,
    rootDir: process.cwd(),
    hotStart: true,
    description: typeof content.instructions === 'string' ? content.instructions.slice(0, 300) : undefined,
    purpose: typeof content.purpose === 'string' ? content.purpose : undefined,
    allowGuests: content.allow_guests === true,
    originSession: session,
    room: content.room === 'none' ? 'none' : 'own',
  });
}

/**
 * Out-of-process finish/retry entry (scripts/slack-agent-flow-finish.ts):
 * S1–S13 minus the S5 hot-add — a separate process cannot start an adapter
 * inside the live host, so the script restarts the service (or says how).
 */
export async function finishSlackAgentFlow(args: {
  slug: string;
  sourceGroupId: string;
  newAgentGroupId: string;
  originInstanceKey?: string;
  rootDir?: string;
  /** Pass true when the original create used allow_guests (plain variant) —
   *  keeps the finish path's DM wiring congruent with the provisioned app. */
  allowGuests?: boolean;
  /** Pass 'none' when the original create used room:'none' — keeps the
   *  finish path from growing a room the caller deliberately skipped. */
  room?: 'own' | 'none';
  /** Called with the pending-install line when the app is waiting on a
   *  workspace install approval — the script prints it so a five-minute wait
   *  does not read as a hang. */
  onInstallPending?: (text: string) => void;
}): Promise<OrchestrateSuccess> {
  return runFlow({
    slug: args.slug,
    displayName: (await getAgentGroup(args.newAgentGroupId))?.name ?? args.slug,
    sourceGroupId: args.sourceGroupId,
    newAgentGroupId: args.newAgentGroupId,
    originInstanceKey: args.originInstanceKey ?? 'slack',
    rootDir: args.rootDir ?? process.cwd(),
    hotStart: false,
    allowGuests: args.allowGuests,
    room: args.room,
    onInstallPending: args.onInstallPending,
  });
}
