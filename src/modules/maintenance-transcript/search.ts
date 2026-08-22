/**
 * Narrowly scoped transcript search over the caller's OWN channel-bound
 * session -- built for Maintenance Coordinator ("what did the workers say
 * this morning?", keyword/date/sender search within the real Maintenance
 * Telegram group), but the scoping rule is generic to any agent group so
 * it never becomes an arbitrary-session reader.
 *
 * Deliberately does NOT accept a session id argument (unlike
 * `ncl sessions history <id>`, which lets a caller pick among its own
 * sessions) -- this always resolves to the caller's single channel-bound
 * session and fails closed if there isn't exactly one, per Priority 2.C's
 * explicit requirement. A2A/task sessions (messaging_group_id IS NULL) are
 * never eligible, so a peer's private conversation with MC can never be
 * searched this way.
 *
 * Storage: session inbound.db already retains full chat history durably --
 * host-sweep only prunes session-echo (cross-session context copy) rows,
 * never real `kind: 'chat'` messages (see src/host-sweep.ts). No new
 * durable log was needed. getInboundHistory(limit) is the existing
 * mailbox-abstraction read method (used today by `ncl sessions history`);
 * it has no server-side date/keyword filter, so this fetches a generous
 * window and filters here -- documented, not hidden, in the tool
 * description.
 */
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';

const FETCH_WINDOW = 5000;
export const DEFAULT_RESULT_LIMIT = 200;
export const MAX_RESULT_LIMIT = 2000;

interface ParsedMessageContent {
  text?: string;
  sender?: string;
  senderId?: string;
  author?: { userId?: string; fullName?: string; userName?: string };
  attachments?: Array<{ name?: string; filename?: string; type?: string; url?: string }>;
}

function safeParse(raw: string): ParsedMessageContent {
  try {
    return JSON.parse(raw) as ParsedMessageContent;
  } catch {
    return { text: raw };
  }
}

export interface TranscriptSearchResult {
  timestamp: string;
  sender: string;
  senderId: string | null;
  text: string;
  attachments: Array<{ name: string; type: string; url: string | null }>;
}

export interface TranscriptSearchOptions {
  agentGroupId: string;
  start?: string;
  end?: string;
  /** Substring match against sender display name and senderId (case-insensitive). */
  worker?: string;
  /** Substring match against message text (case-insensitive). */
  keyword?: string;
  limit?: number;
}

export type TranscriptSearchOutcome =
  | { ok: true; sessionId: string; results: TranscriptSearchResult[]; truncated: boolean }
  | { ok: false; reason: string };

/**
 * Resolve the caller's single channel-bound session. Fails closed (never
 * guesses) if there are zero or more than one -- exactly the "fail closed
 * if the target session/group is ambiguous" requirement.
 */
async function resolveSoleChannelSession(agentGroupId: string): Promise<{ session: Session } | { reason: string }> {
  const sessions = await getSessionsByAgentGroup(agentGroupId);
  const channelSessions = sessions.filter((s) => s.messaging_group_id !== null && s.status === 'active');
  if (channelSessions.length === 0) {
    return { reason: 'no active channel-bound session exists for this agent group -- nothing to search.' };
  }
  if (channelSessions.length > 1) {
    return {
      reason: `${channelSessions.length} active channel-bound sessions exist for this agent group -- ambiguous, refusing to guess which one to search.`,
    };
  }
  return { session: channelSessions[0] };
}

export async function searchMaintenanceTranscript(opts: TranscriptSearchOptions): Promise<TranscriptSearchOutcome> {
  const resolved = await resolveSoleChannelSession(opts.agentGroupId);
  if ('reason' in resolved) return { ok: false, reason: resolved.reason };
  const { session } = resolved;

  const requestedLimit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : DEFAULT_RESULT_LIMIT;
  const limit = Math.min(requestedLimit, MAX_RESULT_LIMIT);

  const history = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
    mailbox.getInboundHistory(FETCH_WINDOW),
  );
  if (!history) return { ok: true, sessionId: session.id, results: [], truncated: false };

  const workerNeedle = opts.worker?.toLowerCase();
  const keywordNeedle = opts.keyword?.toLowerCase();

  const filtered: TranscriptSearchResult[] = [];
  for (const row of history) {
    if (row.kind !== 'chat') continue;
    if (opts.start && row.timestamp < opts.start) continue;
    if (opts.end && row.timestamp > opts.end) continue;

    const parsed = safeParse(row.content);
    const sender = parsed.sender || parsed.author?.fullName || parsed.author?.userName || 'Unknown';
    const senderId = parsed.senderId || parsed.author?.userId || null;
    const text = parsed.text || '';

    if (workerNeedle) {
      const haystack = `${sender} ${senderId ?? ''}`.toLowerCase();
      if (!haystack.includes(workerNeedle)) continue;
    }
    if (keywordNeedle && !text.toLowerCase().includes(keywordNeedle)) continue;

    filtered.push({
      timestamp: row.timestamp,
      sender,
      senderId,
      text,
      attachments: (parsed.attachments ?? []).map((a) => ({
        name: a.name || a.filename || 'attachment',
        type: a.type || 'file',
        url: a.url || null,
      })),
    });
  }

  filtered.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  const truncated = filtered.length > limit;
  return { ok: true, sessionId: session.id, results: filtered.slice(0, limit), truncated };
}
