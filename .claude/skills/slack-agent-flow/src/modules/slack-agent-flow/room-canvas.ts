/**
 * Room canvas creation — the room-contract template, written to the room's
 * channel-tab canvas at room-creation time.
 *
 * Contract C2: `createRoomCanvas` is NON-THROWING — any failure (network,
 * Slack error, malformed response) logs a warning and returns undefined. Room
 * creation must never fail because the canvas leg did; the caller tolerates
 * undefined and simply ships a room without a canvas.
 *
 * The Slack call is implemented locally (plain fetch, the shared slack-lib
 * JSON-body conventions) — this file deliberately does not go through the
 * lib's throwing helpers: canvas creation is contractually NON-THROWING (C2).
 * Tokens travel only in the Authorization header and are never interpolated
 * into messages or logs.
 *
 * Live-validated facts this leans on: `conversations.canvases.create`
 * works on MPIMs and DMs (undocumented but confirmed); every markdown
 * element in the template — checkboxes, tables with user cards, blockquote —
 * is accepted; section headings are the later edit-addressing scheme
 * (`canvases.sections.lookup` by contains_text), so heading text is part of
 * the template's contract with the canvas-actions module.
 */
import { TIMEZONE } from '../../config.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import { formatLocalTime } from '../../timezone.js';
import type { MessagingGroup } from '../../types.js';

const SLACK_API = 'https://slack.com/api';

export interface RoomCanvasOpts {
  roomName: string;
  purpose: string;
  /** The human operator who created the room — the ONLY member the template
   *  may reference by user card. Bot user cards render as @-mentions, and a
   *  creation-time mention is what triggered every sibling instance and
   *  generated the approval-card spam. */
  creatorUserId: string;
  /** Agent members by display name — rendered as PLAIN TEXT, never mentioned. */
  agentNames: string[];
  /** ISO creation timestamp; defaults to now. Rendered install-local. */
  createdAt?: string;
}

/** `![](@U…)` — Slack renders this image syntax as an inline user card.
 *  Humans only: a bot's user card delivers a mention to that bot's instance. */
function userCard(userId: string): string {
  return `![](@${userId})`;
}

/** Blockquote-prefix every line so a multi-line purpose stays one quote block. */
function asBlockquote(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/**
 * The room-contract template (modeled on a live-verified room-canvas
 * example). With the room-contract MESSAGE retired, this canvas IS the room
 * contract: purpose, creator, member list, created date — the canvas tab is
 * the room's pinned surface. Heading texts ("Tasks", "Decisions", "Notes")
 * are load-bearing: agents address sections by contains_text lookup, and the
 * canvas instructions reference them by name.
 *
 * The body must never @-mention a BOT — agent members appear by plain
 * name. Only the (human) creator gets a user card.
 */
export function roomCanvasMarkdown(opts: RoomCanvasOpts): string {
  const memberRows = [
    `| ${userCard(opts.creatorUserId)} | creator |`,
    ...opts.agentNames.filter((name, i, arr) => arr.indexOf(name) === i).map((name) => `| ${name} | agent |`),
  ];

  // No `# <roomName>` heading here: the `title` param on
  // conversations.canvases.create already renders the canvas title as the
  // document's H1 — a body heading would duplicate it (live-observed).
  return [
    asBlockquote(opts.purpose),
    '',
    `Created by ${userCard(opts.creatorUserId)} on ${formatLocalTime(opts.createdAt ?? new Date().toISOString(), TIMEZONE)}.`,
    '',
    '## Members',
    '',
    '| Who | Role |',
    '|---|---|',
    ...memberRows,
    '',
    '## Tasks',
    '',
    '- [ ] Add the room’s first task',
    '',
    '## Decisions',
    '',
    '_No decisions recorded yet — quote them here as they land._',
    '',
    '## Notes',
    '',
    '_Working notes and links — anything worth keeping that isn’t a task or a decision._',
    '',
  ].join('\n');
}

/**
 * Create the room's channel-tab canvas from the room-contract template.
 * Returns the canvas id, or undefined on ANY failure (never throws).
 */
export async function createRoomCanvas(
  botToken: string,
  channelId: string,
  opts: RoomCanvasOpts,
): Promise<string | undefined> {
  try {
    const res = await fetch(`${SLACK_API}/conversations.canvases.create`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${botToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        channel_id: channelId,
        // Undocumented but live-verified: conversations.canvases.create
        // accepts `title` (otherwise the canvas lists as "Untitled").
        title: opts.roomName,
        document_content: { type: 'markdown', markdown: roomCanvasMarkdown(opts) },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (json.ok !== true) {
      log.warn('Room canvas create failed', {
        channelId,
        error: String(json.error ?? `HTTP ${res.status}`),
      });
      return undefined;
    }
    const canvasId = typeof json.canvas_id === 'string' ? json.canvas_id : undefined;
    if (!canvasId) {
      log.warn('Room canvas create returned no canvas_id', { channelId });
      return undefined;
    }
    log.info('Room canvas created', { channelId, canvasId });
    return canvasId;
  } catch (err) {
    log.warn('Room canvas create failed', {
      channelId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

// ── Canvas comments (shadow channel) ──

/** Canvas ids are `F` + the base-36-ish Slack id body. */
const CANVAS_ID_RE = /^F[A-Z0-9]+$/;

/**
 * Live-probed platform fact: creating ANY canvas makes Slack materialize
 * a hidden private "shadow channel" owned by USLACKBOT whose id is the canvas
 * id with the leading `F` swapped for `C` (canvas F0BME4DL401 → channel
 * C0BME4DL401). Canvas comments live there as threads; members of the canvas
 * are members of the shadow channel and bots receive its messages as ordinary
 * message.groups events. Returns undefined for anything not canvas-id shaped.
 */
export function deriveCanvasShadowChannelId(canvasId: string): string | undefined {
  return CANVAS_ID_RE.test(canvasId) ? `C${canvasId.slice(1)}` : undefined;
}

/** One room bot's instance/group pair, for shadow-channel wiring. The flow's
 *  RoomParticipant satisfies this structurally. */
export interface CanvasCommentsParticipant {
  /** Adapter-instance key ('slack' or 'slack-<slug>'). */
  instanceKey: string;
  agentGroupId: string;
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Wire the canvas's shadow channel for EVERY participating instance — the
 * shadow channel is the room's comment stream, so it gets room semantics for
 * all room agents, not creator-only. Creator-only wiring is what turned
 * every sibling's canvas events into unknown-channel approval-card spam.
 *
 * Per participant: one messaging-group row on ITS instance (router lookup is
 * exact-on-instance) plus one wiring to its agent group. The CREATOR is the
 * default responder — pattern `'.'` (always engage): a comment on the shared
 * canvas is always addressed to the room's agents, unlike ambient room chat.
 * Every SIBLING gets mention/accumulate — comments flow to all room agents
 * as context, and tagging an agent in a comment actually triggers it with
 * the anchor context. `unknown_sender_policy: 'public'` keeps access gates
 * from approval-spamming on commenters.
 *
 * Idempotent (get-before-create on every row) and NON-THROWING — like
 * createRoomCanvas, a failure here must never fail room creation. Returns the
 * shadow channel id, or undefined on invalid canvas-id shape or any error.
 */
export async function wireCanvasComments(
  canvasId: string,
  creator: CanvasCommentsParticipant,
  participants: CanvasCommentsParticipant[],
  roomName: string,
): Promise<string | undefined> {
  try {
    const shadowChannelId = deriveCanvasShadowChannelId(canvasId);
    if (!shadowChannelId) {
      log.warn('Canvas comments: unexpected canvas id shape — shadow channel not wired', { canvasId });
      return undefined;
    }
    const platformId = `slack:${shadowChannelId}`;

    // Creator first (its wiring must win even if it also appears in the list).
    const isCreator = (p: CanvasCommentsParticipant): boolean =>
      p.instanceKey === creator.instanceKey && p.agentGroupId === creator.agentGroupId;
    const everyone = [creator, ...participants.filter((p) => !isCreator(p))];

    for (const p of everyone) {
      let mg = await getMessagingGroupByPlatform('slack', platformId, p.instanceKey);
      if (!mg) {
        const row: MessagingGroup = {
          id: generateId('mg'),
          channel_type: 'slack',
          platform_id: platformId,
          instance: p.instanceKey,
          name: `${roomName} canvas comments (canvas ${canvasId})`,
          is_group: 1,
          unknown_sender_policy: 'public',
          created_at: new Date().toISOString(),
        };
        await createMessagingGroup(row);
        mg = row;
      }

      if (!(await getMessagingGroupAgentByPair(mg.id, p.agentGroupId))) {
        const creatorRow = isCreator(p);
        await createMessagingGroupAgent({
          id: generateId('mga'),
          messaging_group_id: mg.id,
          agent_group_id: p.agentGroupId,
          engage_mode: creatorRow ? 'pattern' : 'mention',
          engage_pattern: creatorRow ? '.' : null,
          sender_scope: 'all',
          ignored_message_policy: creatorRow ? 'drop' : 'accumulate',
          session_mode: 'shared',
          priority: 0,
          created_at: new Date().toISOString(),
        });
      }
    }

    log.info('Canvas comments shadow channel wired', {
      canvasId,
      shadowChannelId,
      creatorInstance: creator.instanceKey,
      participantCount: everyone.length,
    });
    return shadowChannelId;
  } catch (err) {
    log.warn('Canvas comments shadow-channel wiring failed', {
      canvasId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
