/**
 * `ncl sessions history <session-id>` — the pull layer of cross-session
 * context: full-depth catch-up on another conversation after the push
 * layer's one-line ambient copies.
 *
 * Reads the target session's inbound messages_in + outbound messages_out
 * (both read-only; safe with a live container) merged chronologically.
 *
 * SCOPING: custom operations bypass the dispatcher's generic post-handler
 * scope filter, so this handler self-scopes like tasks.ts `ownSession` —
 * an agent caller asking about another group's session gets the same
 * "session not found" as a nonexistent id (no cross-group existence oracle).
 */
import { TIMEZONE } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { formatLocalStamp } from '../../timezone.js';
import type { CallerContext } from '../../cli/frame.js';
import {
  ECHO_CHANNEL_TIMELINE_SURFACE,
  ECHO_CHANNEL_TYPE,
  ECHO_SIBLING_SURFACE,
  ECHO_TASK_SURFACE,
  ECHO_TIMELINE_SURFACE,
} from './config.js';

export const HISTORY_DEFAULT_LIMIT = 50;
/** Per-line text cap in the human pipe-separated rendering. */
export const HISTORY_TEXT_MAX_CHARS = 200;

/**
 * Legacy inference, for copies written before writers recorded `delivered`
 * and `truncated`. Consumed echo rows are never pruned (prunePendingMessages
 * removes only pending ones), so such copies can stay in a mailbox
 * indefinitely and this fallback must stay. The caps are the values those
 * writers used, fixed here on purpose: they must not follow later changes to
 * ECHO_TEXT_MAX_CHARS or BACKFILL_LAST_MAX_CHARS.
 */
const LEGACY_ECHO_TEXT_MAX_CHARS = 500;
const LEGACY_BACKFILL_LAST_MAX_CHARS = 4000;
/** Surfaces only the delivery hook (fan.ts, after markDelivered) wrote with `self`. */
const LEGACY_DELIVERED_SURFACES = new Set<string>([ECHO_SIBLING_SURFACE, ECHO_TASK_SURFACE]);
/** Surfaces only backfill writes (where the newest entry was cut without '…'). */
const BACKFILL_SURFACES = new Set<string>([ECHO_TIMELINE_SURFACE, ECHO_CHANNEL_TIMELINE_SURFACE]);

/**
 * Marks an inbound row that is a cross-session copy ('session-echo'), not a
 * message this session received. Without it a copy of a sibling session's
 * delivered reply reads as an incoming message nobody answered. Every field
 * comes from what the echo writer recorded (fan.ts, backfill.ts); only copies
 * written before writers recorded `delivered`/`truncated` fall back to
 * inference (see LEGACY_*).
 */
export interface HistoryEcho {
  /** The session the original appeared in (null only on copies written before backfill recorded it). */
  fromSession: string | null;
  /** The writer's description of where it came from, e.g. "another thread with Alex". */
  label: string | null;
  /** The agent's own message (shown to it as "you"). */
  self: boolean;
  /** The agent's own message, copied by the delivery hook after it was delivered. */
  delivered: boolean;
  /** The writer cut the text; the full text is in `fromSession`'s history (`--json`). */
  truncated: boolean;
}

/**
 * Human `kind` cell for a copy. The kind column comes from the row, never
 * from message text, so it is the field to trust: anyone can type a
 * "[from …]" prefix into a real message, but not a `copy-*` kind.
 */
export function echoKind(echo: HistoryEcho): string {
  return echo.delivered ? 'copy-delivered' : echo.self ? 'copy-earlier' : 'copy-received';
}

export interface HistoryRow {
  /** ISO-8601 UTC on the wire; the human renderer localizes. */
  timestamp: string;
  direction: 'in' | 'out';
  kind: string;
  sender: string;
  text: string;
  /** Present only on cross-session copies. */
  echo?: HistoryEcho;
}

/** Keep the one-line-per-message format intact: newlines and pipes would shred line/field parsing. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\|/g, '/').trim();
}

/** Cap by code points, so a cut never splits a character such as an emoji. */
function capChars(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length > max ? chars.slice(0, max).join('') : value;
}

function cell(value: string): string {
  return capChars(oneLine(value), HISTORY_TEXT_MAX_CHARS);
}

/** Cap on the marker's source description (session id + label; a label can carry a long chat name). */
const ECHO_WHERE_MAX_CHARS = 80;

interface ParsedContent {
  text: string;
  sender: string | null;
  self: boolean;
  /** `truncated` / `delivered` are null when the writer did not record them (older copies). */
  echo: {
    surface: string | null;
    label: string | null;
    truncated: boolean | null;
    delivered: boolean | null;
  } | null;
}

function parseText(raw: string): ParsedContent {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const text =
      typeof parsed.text === 'string' && parsed.text.length > 0
        ? parsed.text
        : typeof parsed.action === 'string'
          ? `[${parsed.action}]`
          : '';
    const e = parsed.echo && typeof parsed.echo === 'object' ? (parsed.echo as Record<string, unknown>) : null;
    return {
      text,
      sender: typeof parsed.sender === 'string' ? parsed.sender : null,
      self: parsed.self === true,
      echo: e
        ? {
            surface: typeof e.surface === 'string' ? e.surface : null,
            label: typeof e.label === 'string' && e.label.length > 0 ? e.label : null,
            truncated: typeof e.truncated === 'boolean' ? e.truncated : null,
            delivered: typeof e.delivered === 'boolean' ? e.delivered : null,
          }
        : null,
    };
  } catch {
    return { text: raw, sender: null, self: false, echo: null };
  }
}

/**
 * Older copies carry no `truncated` flag. Their writers used exactly two cut
 * shapes: the echo cap plus '…' (fan.ts, earlier backfill entries), and the
 * newest backfill entry cut at its cap with no '…' (backfill surfaces only).
 */
function legacyTruncated(text: string, surface: string | null): boolean {
  if (text.length === LEGACY_ECHO_TEXT_MAX_CHARS + 1 && text.endsWith('…')) return true;
  return surface !== null && BACKFILL_SURFACES.has(surface) && text.length === LEGACY_BACKFILL_LAST_MAX_CHARS;
}

function toHistoryEcho(content: ParsedContent, sourceSessionId: string | null): HistoryEcho {
  const surface = content.echo?.surface ?? null;
  return {
    fromSession: sourceSessionId,
    label: content.echo?.label ?? null,
    self: content.self,
    delivered: content.echo?.delivered ?? (content.self && surface !== null && LEGACY_DELIVERED_SURFACES.has(surface)),
    truncated: content.echo?.truncated ?? legacyTruncated(content.text, surface),
  };
}

/**
 * Bracketed "where from" prefix for an echo row's text. The status lives in
 * the kind column (echoKind); this only says where the copy came from and
 * whether it was shortened. Brackets in the label are neutralised so a chat
 * name cannot close the marker early, and the cap counts code points so it
 * never splits a character. Kept outside the text cap.
 */
function echoMarker(echo: HistoryEcho): string {
  const full =
    oneLine([echo.fromSession, echo.label].filter(Boolean).join(', ')).replace(/\[/g, '(').replace(/\]/g, ')') ||
    'another conversation';
  const chars = Array.from(full);
  const where = chars.length > ECHO_WHERE_MAX_CHARS ? `${chars.slice(0, ECHO_WHERE_MAX_CHARS).join('')}…` : full;
  const cut = echo.truncated
    ? echo.fromSession
      ? '; copy shortened, full text in that session (--json)'
      : '; copy shortened'
    : '';
  return `[from ${where}${cut}]`;
}

/**
 * Handler for the sessions `history` custom operation. Returns the merged
 * transcript as structured rows (newest `limit`, chronological order) —
 * the frame `data`, so `--json` callers get real rows with ISO timestamps.
 * Human rendering (pipe lines, localized stamps, capped cells) lives in
 * `formatHistoryLines`, wired as the operation's `formatHuman`.
 */
export async function sessionHistory(args: Record<string, unknown>, ctx: CallerContext): Promise<HistoryRow[]> {
  const sessionId = typeof args.id === 'string' && args.id.length > 0 ? args.id : undefined;
  if (!sessionId) throw new Error('session id is required');
  const limitRaw = Number(args.limit ?? HISTORY_DEFAULT_LIMIT);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : HISTORY_DEFAULT_LIMIT;

  const session = await getSession(sessionId);
  // Self-scope (see header): cross-group agents get "not found", never "forbidden".
  if (!session || (ctx.caller === 'agent' && session.agent_group_id !== ctx.agentGroupId)) {
    throw new Error(`session not found: ${sessionId}`);
  }

  const agentName = (await getAgentGroup(session.agent_group_id))?.name ?? 'agent';
  const rows: HistoryRow[] = [];

  const history = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => ({
    inbound: mailbox.getInboundHistory(limit),
    outbound: mailbox.getOutboundHistory(limit),
  }));

  if (history) {
    for (const r of history.inbound) {
      const content = parseText(r.content);
      const row: HistoryRow = {
        timestamp: r.timestamp,
        direction: 'in',
        kind: r.kind,
        sender: content.sender ?? '',
        text: content.text,
      };
      if (r.channelType === ECHO_CHANNEL_TYPE) row.echo = toHistoryEcho(content, r.sourceSessionId);
      rows.push(row);
    }
    for (const r of history.outbound) {
      const { text } = parseText(r.content);
      rows.push({ timestamp: r.timestamp, direction: 'out', kind: r.kind, sender: agentName, text });
    }
  }

  rows.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  return rows.slice(-limit);
}

/**
 * Human rendering: pipe-separated lines
 *   timestamp|direction(in/out)|kind|sender|text(first 200 chars)
 * with the timestamp in the install timezone (`timezone` injectable for
 * deterministic tests). A cross-session copy shows `copy-delivered`,
 * `copy-earlier` or `copy-received` in the kind column, and its text starts
 * with a "[from …]" marker that does not count against the text cap.
 * `--json` bypasses this and gets the raw rows, where copies carry an `echo`
 * object instead.
 */
export function formatHistoryLines(rows: HistoryRow[], timezone: string = TIMEZONE): string {
  return rows
    .map((r) => {
      const kind = r.echo ? echoKind(r.echo) : r.kind;
      const marker = r.echo ? `${echoMarker(r.echo)} ` : '';
      return `${formatLocalStamp(new Date(r.timestamp), timezone)}|${r.direction}|${kind}|${cell(r.sender)}|${marker}${cell(r.text)}`;
    })
    .join('\n');
}
