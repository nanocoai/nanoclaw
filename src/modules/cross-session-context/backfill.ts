/**
 * New-session backfill — the pull half of cross-session context.
 *
 * The fan-out layer (fan.ts) pushes echoes only into sessions that EXIST at
 * delivery time, so a brand-new per-thread session is born blind: the user
 * replies to something said at the conversation's top level (live-hit: the
 * welcome message tour offer in a DM) and the fresh session has no idea. At
 * session birth we seed the new session with the most recent user-facing
 * exchanges from sibling sessions of the SAME messaging group — identical
 * audience, DM or group alike, so the same privacy argument as the sibling
 * fan applies.
 *
 * Bounded: last BACKFILL_LIMIT rows across all siblings, echo truncation as
 * usual. Rows are trigger=0 session-echo rows written BEFORE the triggering
 * message (lower seq → the formatter renders them first, as ambient context).
 */
import { getSessionsByAgentGroup, isTaskThread } from '../../db/sessions.js';
import { log } from '../../log.js';
import { withExistingMailboxSession, writeSessionMessage } from '../../session-manager.js';
import type { AgentGroup, MessagingGroup, Session } from '../../types.js';
import { ECHO_CHANNEL_TIMELINE_SURFACE, ECHO_CHANNEL_TYPE, ECHO_TIMELINE_SURFACE } from './config.js';
import { truncateEchoText } from './fan.js';

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
 * TOP-LEVEL timeline rows from one sibling session — what a human sees
 * scrolling the DM's Messages tab, not the interiors of other threads:
 *  - the session's ROOT user message (per-thread sessions: the first
 *    triggering chat row IS the conversation opener), and
 *  - top-level agent posts (outbound with an empty/absent thread — e.g. the
 *    welcome message), which start conversations of their own.
 * Thread replies stay in their threads; deep conversations contribute one
 * line here, not their whole tail.
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

/**
 * Seed a just-created session with recent sibling context from the SAME
 * conversation. Group surfaces can be per-thread like DMs, so both get the
 * conversation's top-level timeline at thread birth — same messaging group
 * means the same audience. Call BEFORE the triggering message is written.
 * Non-throwing; no-ops for task sessions and sessions with no siblings.
 */
export async function backfillNewSession(agentGroup: AgentGroup, session: Session, mg: MessagingGroup): Promise<void> {
  try {
    if (session.thread_id !== null && isTaskThread(session.thread_id)) return;

    const siblings = (await getSessionsByAgentGroup(agentGroup.id)).filter(
      (s) => s.id !== session.id && s.status === 'active' && s.messaging_group_id === mg.id,
    );
    if (siblings.length === 0) return;

    const rows: BackfillRow[] = [];
    for (const sibling of siblings) {
      rows.push(...(await collectSiblingTopLevel(agentGroup, sibling.id, BACKFILL_LIMIT)));
    }
    rows.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
    const newest = rows.slice(-BACKFILL_LIMIT);
    if (newest.length === 0) return;

    const isGroupSurface = mg.is_group === 1;
    const label = isGroupSurface
      ? 'this channel, just before this conversation'
      : 'this DM, just before this conversation';
    const surface = isGroupSurface ? ECHO_CHANNEL_TIMELINE_SURFACE : ECHO_TIMELINE_SURFACE;
    for (const [i, row] of newest.entries()) {
      // The most recent entry is what a short opener ("sure") is usually
      // answering — deliver it whole; earlier entries get the normal cap.
      const isLast = i === newest.length - 1;
      await writeSessionMessage(agentGroup.id, session.id, {
        id: `${session.id}:backfill:${i}`,
        kind: 'chat',
        timestamp: row.timestamp,
        channelType: ECHO_CHANNEL_TYPE,
        content: JSON.stringify({
          text: isLast ? row.text.slice(0, 4000) : truncateEchoText(row.text),
          sender: row.sender,
          senderId: row.senderId,
          ...(row.self ? { self: true } : {}),
          echo: { surface, label },
        }),
        trigger: false,
      });
    }
    log.debug('Backfilled new session with conversation timeline', {
      sessionId: session.id,
      rows: newest.length,
      siblings: siblings.length,
    });
  } catch (err) {
    log.warn('New-session backfill failed (continuing without context)', { sessionId: session.id, err });
  }
}
