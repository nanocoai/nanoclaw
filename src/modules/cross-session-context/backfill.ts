/**
 * Session backfill — the pull half of cross-session context.
 *
 * The fan-out layer (fan.ts) pushes live echoes only into the conversation's
 * HOT SET (its most recently active sessions), so two kinds of session wake
 * without the context a hot sibling would have:
 *   - a brand-new per-thread session, born blind: the user replies to
 *     something said at the conversation's top level (live-hit: the welcome
 *     message tour offer in a DM) and the fresh session has no idea;
 *   - a long-idle session that dropped out of the hot set and missed every
 *     echo since.
 * Before such a session's trigger is written we seed it from the hot set
 * with the conversation's TOP-LEVEL timeline — what a human sees scrolling
 * the DM's Messages tab, not the interiors of other threads. Same messaging
 * group = identical audience, so the sibling fan's privacy argument applies.
 * A hot existing session has been receiving live echoes and is left alone.
 *
 * Bounded: sources are the ≤ K+1 hot sessions, read concurrently; rows are
 * newer than what the session already has (its newest row) and never older
 * than ECHO_MAX_AGE_DAYS; the newest BACKFILL_LIMIT survive, written in ONE
 * mailbox session as trigger=0 session-echo rows BEFORE the trigger (lower
 * seq → the formatter renders them first, as ambient context). Never throws.
 */
import { isTaskThread } from '../../db/sessions.js';
import { log } from '../../log.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import type { AgentGroup, MessagingGroup, Session } from '../../types.js';
import {
  ECHO_CHANNEL_TIMELINE_SURFACE,
  ECHO_CHANNEL_TYPE,
  ECHO_CONCURRENCY,
  ECHO_MAX_AGE_MS,
  ECHO_TIMELINE_SURFACE,
} from './config.js';
import { loadHotCandidates, selectEchoTargets, selectHotSessions, truncateEchoText } from './fan.js';
import { mapConcurrent } from './parallel.js';

export const BACKFILL_LIMIT = 12;

interface BackfillRow {
  timestamp: string;
  sender: string;
  senderId: string;
  text: string;
  /** Row authored by the agent itself — rendered as "you" in the prelude. */
  self: boolean;
}

function parseContent(raw: string): { text?: string; sender?: string; senderId?: string; echo?: unknown } {
  try {
    return JSON.parse(raw) as { text?: string; sender?: string; senderId?: string; echo?: unknown };
  } catch {
    return {};
  }
}

/**
 * TOP-LEVEL timeline rows from one sibling session:
 *  - the session's ROOT user message (per-thread sessions: the first
 *    triggering chat row IS the conversation opener), and
 *  - top-level agent posts (outbound with an empty/absent thread — e.g. the
 *    welcome message), which start conversations of their own.
 * Thread replies stay in their threads; deep conversations contribute one
 * line here, not their whole tail. Throws on a broken mailbox — the caller
 * isolates per sibling.
 */
async function collectSiblingTopLevel(
  agentGroup: AgentGroup,
  sessionId: string,
  limit: number,
): Promise<BackfillRow[]> {
  const rows: BackfillRow[] = [];
  const timeline = await withExistingMailboxSession(agentGroup.id, sessionId, (mailbox) => ({
    root: mailbox.getConversationRoot(),
    outbound: mailbox.getTopLevelOutbound(limit),
  }));
  if (!timeline) return rows;

  if (timeline.root) {
    const r = timeline.root;
    const c = parseContent(r.content);
    if (c.text && c.senderId !== 'system' && c.sender !== 'system' && !c.text.startsWith('System instruction:')) {
      // Host-injected triggers (the welcome hand-off) are attributed to the
      // OWNER for sender-gating, so filter them by shape too — internal
      // prompts must never surface as user timeline entries (live-hit: the
      // raw "System instruction: run /welcome…" leaked into a new thread).
      rows.push({
        timestamp: r.timestamp,
        sender: c.sender ?? 'user',
        senderId: c.senderId ?? '',
        text: c.text,
        self: false,
      });
    }
  }

  for (const r of timeline.outbound) {
    const c = parseContent(r.content);
    if (!c.text) continue;
    rows.push({
      timestamp: r.timestamp,
      sender: agentGroup.name,
      senderId: agentGroup.id,
      text: c.text,
      self: true,
    });
  }
  return rows;
}

export interface BackfillOptions {
  /** The session was created for the very message about to be written. */
  created: boolean;
  /** Injectable clock (tests). */
  now?: number;
}

/**
 * Seed a waking session with recent top-level context from the hot set of
 * the SAME conversation, when it is new or has been idle long enough to miss
 * live echoes. Call BEFORE the triggering message is written. Non-throwing;
 * no-ops for task sessions, hot sessions, and sessions with no hot siblings.
 */
export async function backfillSession(
  agentGroup: AgentGroup,
  session: Session,
  mg: MessagingGroup,
  options: BackfillOptions,
): Promise<void> {
  try {
    if (session.thread_id !== null && isTaskThread(session.thread_id)) return;
    const now = options.now ?? Date.now();

    const candidates = await loadHotCandidates(agentGroup.id, mg.id, now);
    // A hot existing session has been receiving live fans — nothing to catch
    // up on. (Hot = among the conversation's K most recently active sessions,
    // ranked BEFORE this trigger bumps its last_active; that rank can only have
    // been better at any earlier point, so it heard every fan since its own
    // last message.)
    if (!options.created && selectHotSessions(candidates, mg.id, now).some((s) => s.id === session.id)) return;
    // Sources: the hot set of the OTHER sessions — exactly what a live fan
    // from any of them would have reached.
    const sources = selectEchoTargets(candidates, session.id, mg.id, now);
    if (sources.length === 0) return;

    // Catch-up floor: the newest point in the conversation the session already
    // knows about (its newest row — own messages or echoes it received while
    // hot), never older than the ambient horizon.
    let sinceMs = now - ECHO_MAX_AGE_MS;
    if (!options.created) {
      const newest = await withExistingMailboxSession(
        agentGroup.id,
        session.id,
        (mailbox) => mailbox.getInboundHistory(1)[0]?.timestamp ?? null,
      );
      // Mailbox gone (operator reset): the trigger write re-provisions it; nothing to seed into.
      if (newest === undefined) return;
      if (newest !== null) sinceMs = Math.max(sinceMs, Date.parse(newest));
    }

    const reads = await mapConcurrent(sources, ECHO_CONCURRENCY, (sibling) =>
      collectSiblingTopLevel(agentGroup, sibling.id, BACKFILL_LIMIT),
    );
    const rows: BackfillRow[] = [];
    reads.forEach((result, i) => {
      if (result.status === 'fulfilled') rows.push(...result.value);
      else
        log.warn('Backfill sibling read failed', {
          sessionId: session.id,
          siblingId: sources[i].id,
          err: result.reason,
        });
    });
    const fresh = rows.filter((row) => Date.parse(row.timestamp) > sinceMs);
    fresh.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
    const newest = fresh.slice(-BACKFILL_LIMIT);
    if (newest.length === 0) return;

    const isGroupSurface = mg.is_group === 1;
    const where = isGroupSurface ? 'this channel' : 'this DM';
    const label = options.created
      ? `${where}, just before this conversation`
      : `${where}, while this conversation was idle`;
    const surface = isGroupSurface ? ECHO_CHANNEL_TIMELINE_SURFACE : ECHO_TIMELINE_SURFACE;
    // One batch id per wake keeps repeated catch-ups of the same session collision-free.
    const batch = new Date(now).toISOString();
    await withExistingMailboxSession(agentGroup.id, session.id, async (mailbox) => {
      for (const [i, row] of newest.entries()) {
        // The most recent entry is what a short opener ("sure") is usually
        // answering — deliver it whole; earlier entries get the normal cap.
        const isLast = i === newest.length - 1;
        await mailbox.insertMessage({
          id: `${session.id}:backfill:${batch}:${i}`,
          kind: 'chat',
          timestamp: row.timestamp,
          platformId: null,
          channelType: ECHO_CHANNEL_TYPE,
          threadId: null,
          content: JSON.stringify({
            text: isLast ? row.text.slice(0, 4000) : truncateEchoText(row.text),
            sender: row.sender,
            senderId: row.senderId,
            ...(row.self ? { self: true } : {}),
            echo: { surface, label },
          }),
          processAfter: null,
          recurrence: null,
          trigger: false,
          sourceSessionId: null,
          onWake: false,
        });
      }
    });
    log.debug('Backfilled session with conversation timeline', {
      sessionId: session.id,
      rows: newest.length,
      sources: sources.length,
      created: options.created,
    });
  } catch (err) {
    log.warn('Session backfill failed (continuing without context)', { sessionId: session.id, err });
  }
}
