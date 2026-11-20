/**
 * Conversation timeline — the top-level talk of each conversation, recorded as
 * the Host sees it, for the session backfill (backfill.ts).
 *
 * The backfill seeds a new or long-idle session with what its hot siblings
 * hold at the conversation's top level: each one's root user message and its
 * top-level agent posts. Reading those from the siblings' mailboxes opened
 * each sibling whole; on a remote mailbox a session that is not in memory is
 * read record by record, so a new thread's first message waited for up to
 * eight whole sessions before it was written (live: 12 to 23 s on a Host
 * just restarted). The Host already sees each of those messages once, at the
 * moment it happens: the router writes a new session's first message, and
 * delivery sends each agent post. It records them here then, and the
 * backfill reads them with one indexed query.
 *
 * Rows older than the backfill's horizon (ECHO_MAX_AGE_MS) are never read and
 * are deleted when their conversation records its next row. A session's rows
 * are deleted with the session.
 */
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { ECHO_CHANNEL_TYPE, ECHO_MAX_AGE_MS } from './config.js';

/** The longest text kept for one row: the most the backfill writes for any row. */
export const TIMELINE_TEXT_MAX_CHARS = 4000;

export interface TimelineRow {
  sessionId: string;
  timestamp: string;
  sender: string;
  senderId: string;
  text: string;
  /** Written by the agent itself. */
  self: boolean;
  platformMessageId?: string;
}

interface TimelineSqlRow {
  session_id: string;
  timestamp: string;
  sender: string;
  sender_id: string;
  text: string;
  self: number;
  platform_message_id: string | null;
}

const CHAT_KINDS = new Set(['chat', 'chat-sdk']);

function parse(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    // eslint-disable-next-line no-catch-all/no-catch-all -- a row that is not JSON has no text to record
  } catch {
    return {};
  }
}

async function record(
  id: string,
  session: Session,
  messagingGroupId: string,
  row: Omit<TimelineRow, 'sessionId'>,
): Promise<void> {
  const at = Date.parse(row.timestamp);
  if (Number.isNaN(at)) return;
  const db = getDb();
  await db.run(
    `INSERT INTO conversation_timeline
       (id, agent_group_id, messaging_group_id, session_id, timestamp, sender, sender_id, text, self, platform_message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
    id,
    session.agent_group_id,
    messagingGroupId,
    session.id,
    new Date(at).toISOString(),
    row.sender,
    row.senderId,
    row.text.slice(0, TIMELINE_TEXT_MAX_CHARS),
    row.self ? 1 : 0,
    row.platformMessageId ?? null,
  );
  await db.run(
    'DELETE FROM conversation_timeline WHERE agent_group_id = ? AND messaging_group_id = ? AND timestamp < ?',
    session.agent_group_id,
    messagingGroupId,
    new Date(at - ECHO_MAX_AGE_MS).toISOString(),
  );
}

/**
 * A session's root: the user message it was created for. The same rows the
 * mailbox's conversation root gave: a chat message on a real chat surface,
 * never a Host-injected instruction (the welcome hand-off is attributed to the
 * owner, so it is filtered by its shape too). Never throws.
 */
export async function recordConversationRoot(
  session: Session,
  message: { kind: string; channelType: string | null; content: string; timestamp: string },
): Promise<void> {
  try {
    if (!session.messaging_group_id || !CHAT_KINDS.has(message.kind)) return;
    if (message.channelType === 'agent' || message.channelType === ECHO_CHANNEL_TYPE) return;
    const c = parse(message.content);
    const text = typeof c.text === 'string' ? c.text : '';
    const sender = typeof c.sender === 'string' ? c.sender : undefined;
    const senderId = typeof c.senderId === 'string' ? c.senderId : undefined;
    if (!text || senderId === 'system' || sender === 'system' || text.startsWith('System instruction:')) return;
    await record(`${session.id}:root`, session, session.messaging_group_id, {
      timestamp: message.timestamp,
      sender: sender ?? 'user',
      senderId: senderId ?? '',
      text,
      self: false,
      // A held message carries the platform's id as `id` (the chat library's serialized message).
      platformMessageId: typeof c.id === 'string' ? c.id : undefined,
    });
    // eslint-disable-next-line no-catch-all/no-catch-all -- context only: the message is written either way
  } catch (err) {
    log.warn('Conversation timeline: root not recorded', { sessionId: session.id, err });
  }
}

/**
 * An agent post at the conversation's top level, once delivered: the same rows
 * the mailbox's top-level outbound gave (no system or task-log rows, no
 * agent-to-agent rows, no thread or a thread id that names only the chat).
 * Never throws.
 */
export async function recordTopLevelPost(
  session: Session,
  agentGroupName: string,
  message: { id: string; kind: string; channelType: string | null; threadId: string | null; content: string },
  platformMessageId: string | null,
  timestamp: string = new Date().toISOString(),
): Promise<void> {
  try {
    if (!session.messaging_group_id) return;
    if (message.kind === 'system' || message.kind === 'task_log' || message.channelType === 'agent') return;
    if (message.threadId && !message.threadId.endsWith(':')) return;
    const c = parse(message.content);
    const text = typeof c.text === 'string' ? c.text : '';
    if (!text) return;
    await record(`${session.id}:out:${message.id}`, session, session.messaging_group_id, {
      timestamp,
      sender: agentGroupName,
      senderId: session.agent_group_id,
      text,
      self: true,
      platformMessageId: platformMessageId ?? undefined,
    });
    // eslint-disable-next-line no-catch-all/no-catch-all -- context only: the post is delivered either way
  } catch (err) {
    log.warn('Conversation timeline: post not recorded', { sessionId: session.id, messageId: message.id, err });
  }
}

/** The newest rows of the given sessions of one conversation, newer than `sinceIso`, oldest first. */
export async function readConversationTimeline(
  agentGroupId: string,
  messagingGroupId: string,
  sessionIds: string[],
  sinceIso: string,
  limit: number,
): Promise<TimelineRow[]> {
  if (sessionIds.length === 0) return [];
  const rows = await getDb().all<TimelineSqlRow>(
    `SELECT session_id, timestamp, sender, sender_id, text, self, platform_message_id
       FROM conversation_timeline
      WHERE agent_group_id = ? AND messaging_group_id = ? AND timestamp > ?
        AND session_id IN (${sessionIds.map(() => '?').join(', ')})
      ORDER BY timestamp DESC
      LIMIT ?`,
    agentGroupId,
    messagingGroupId,
    sinceIso,
    ...sessionIds,
    limit,
  );
  return rows.reverse().map((r) => ({
    sessionId: r.session_id,
    timestamp: r.timestamp,
    sender: r.sender,
    senderId: r.sender_id,
    text: r.text,
    self: r.self === 1,
    platformMessageId: r.platform_message_id ?? undefined,
  }));
}
