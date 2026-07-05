/**
 * Outbound message operations (container side).
 *
 * Writes to outbound.db (container-owned).
 * The host polls this DB (read-only) for undelivered messages.
 */
import { getInboundDb, getOutboundDb } from './connection.js';

export interface MessageOutRow {
  id: string;
  seq: number | null;
  in_reply_to: string | null;
  timestamp: string;
  deliver_after: string | null;
  recurrence: string | null;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

export interface WriteMessageOut {
  id: string;
  in_reply_to?: string | null;
  deliver_after?: string | null;
  recurrence?: string | null;
  kind: string;
  platform_id?: string | null;
  channel_type?: string | null;
  thread_id?: string | null;
  content: string;
}

/**
 * Idempotent-outbound guard. The same reply can reach writeMessageOut via
 * several paths in one turn: the send_message MCP tool (mid-turn), a
 * <message> block in the final result text (end-of-turn dispatch in
 * poll-loop), and a re-send after the "output was not wrapped" nudge.
 * Without a guard the user sees the same text 2–3 times.
 *
 * Scope is deliberately narrow: only immediate user-facing chat messages
 * (kind='chat', no deliver_after/recurrence — scheduled reminders may
 * legitimately repeat). A message is a duplicate when an identical
 * (platform_id, channel_type, content) row was written within the window.
 */
const DEDUP_WINDOW_SECONDS = 60;

function findRecentDuplicateSeq(msg: WriteMessageOut): number | null {
  if (msg.kind !== 'chat' || msg.deliver_after || msg.recurrence) return null;
  const row = getOutboundDb()
    .prepare(
      `SELECT seq FROM messages_out
       WHERE kind = 'chat'
         AND platform_id IS $pid AND channel_type IS $ct AND content = $content
         AND deliver_after IS NULL AND recurrence IS NULL
         AND timestamp >= datetime('now', '-${DEDUP_WINDOW_SECONDS} seconds')
       ORDER BY seq DESC LIMIT 1`,
    )
    .get({
      $pid: msg.platform_id ?? null,
      $ct: msg.channel_type ?? null,
      $content: msg.content,
    }) as { seq: number } | undefined;
  return row?.seq ?? null;
}

/**
 * Write a new outbound message, auto-assigning an odd seq number.
 * Container uses odd seq (1, 3, 5...), host uses even (2, 4, 6...).
 *
 * The disjoint namespace is load-bearing, not just collision avoidance:
 * seq is the agent-facing message ID returned by send_message and accepted
 * by edit_message / add_reaction, and getMessageIdBySeq() below looks up
 * by seq across BOTH tables. If inbound and outbound could share a seq,
 * the agent's "edit message #5" could resolve to the wrong row.
 *
 * Duplicate chat sends (see findRecentDuplicateSeq) are skipped: the
 * existing row's seq is returned so callers (send_message, edit_message)
 * keep a stable agent-facing id, and the host never sees a second row.
 */
export function writeMessageOut(msg: WriteMessageOut): number {
  const duplicateSeq = findRecentDuplicateSeq(msg);
  if (duplicateSeq != null) {
    console.error(
      `[messages-out] Skipping duplicate outbound chat message (seq #${duplicateSeq} already sent to ${msg.channel_type}:${msg.platform_id} within ${DEDUP_WINDOW_SECONDS}s)`,
    );
    return duplicateSeq;
  }

  const outbound = getOutboundDb();
  const inbound = getInboundDb();

  // Read max seq from both DBs to maintain global ordering.
  // Safe: each side only reads the other DB, never writes to it.
  const maxOut = (outbound.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_out').get() as { m: number }).m;
  const maxIn = (inbound.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
  const max = Math.max(maxOut, maxIn);
  const nextSeq = max % 2 === 0 ? max + 1 : max + 2; // next odd

  // bun:sqlite requires named parameters to be passed with the prefix character
  // in the JS object keys (better-sqlite3 auto-stripped it, bun:sqlite does not).
  outbound
    .prepare(
      `INSERT INTO messages_out (id, seq, in_reply_to, timestamp, deliver_after, recurrence, kind, platform_id, channel_type, thread_id, content)
     VALUES ($id, $seq, $in_reply_to, datetime('now'), $deliver_after, $recurrence, $kind, $platform_id, $channel_type, $thread_id, $content)`,
    )
    .run({
      $id: msg.id,
      $seq: nextSeq,
      $in_reply_to: msg.in_reply_to ?? null,
      $deliver_after: msg.deliver_after ?? null,
      $recurrence: msg.recurrence ?? null,
      $kind: msg.kind,
      $platform_id: msg.platform_id ?? null,
      $channel_type: msg.channel_type ?? null,
      $thread_id: msg.thread_id ?? null,
      $content: msg.content,
    });

  return nextSeq;
}

/**
 * Look up a message's platform ID by seq number.
 * Searches both inbound and outbound DBs since seq spans both.
 *
 * For inbound messages, the Chat SDK message ID is already the platform message ID
 * (e.g., "6037840640:42" for Telegram).
 *
 * For outbound messages, the internal ID (msg-xxx) won't work for edits/reactions.
 * Instead, look up the platform_message_id from the delivered table (host writes this
 * after successful delivery).
 */
export function getMessageIdBySeq(seq: number): string | null {
  const inbound = getInboundDb();

  // Inbound messages: ID is already the platform message ID
  const inRow = inbound.prepare('SELECT id FROM messages_in WHERE seq = ?').get(seq) as
    | { id: string }
    | undefined;
  if (inRow) return inRow.id;

  // Outbound messages: look up platform message ID from delivered table
  const outRow = getOutboundDb().prepare('SELECT id FROM messages_out WHERE seq = ?').get(seq) as
    | { id: string }
    | undefined;
  if (!outRow) return null;

  // Check if host has stored the platform message ID after delivery
  const deliveredRow = inbound
    .prepare('SELECT platform_message_id FROM delivered WHERE message_out_id = ?')
    .get(outRow.id) as { platform_message_id: string | null } | undefined;
  if (deliveredRow?.platform_message_id) return deliveredRow.platform_message_id;

  // Fallback to internal ID (edits/reactions on undelivered messages won't work)
  return outRow.id;
}

/**
 * Look up the routing fields for a message by seq (for edit/reaction targeting).
 * Returns the channel_type, platform_id, thread_id of the referenced message.
 */
export function getRoutingBySeq(
  seq: number,
): { channel_type: string | null; platform_id: string | null; thread_id: string | null } | null {
  const inbound = getInboundDb();
  const inRow = inbound
    .prepare('SELECT channel_type, platform_id, thread_id FROM messages_in WHERE seq = ?')
    .get(seq) as { channel_type: string | null; platform_id: string | null; thread_id: string | null } | undefined;
  if (inRow) return inRow;

  const outRow = getOutboundDb()
    .prepare('SELECT channel_type, platform_id, thread_id FROM messages_out WHERE seq = ?')
    .get(seq) as { channel_type: string | null; platform_id: string | null; thread_id: string | null } | undefined;
  return outRow ?? null;
}

/**
 * Highest outbound seq right now (0 when empty). Poll-loop snapshots this at
 * prompt start and uses countChatSendsSince() to know whether the agent
 * already delivered something this turn (e.g. via the send_message MCP tool).
 */
export function getMaxOutSeq(): number {
  return (getOutboundDb().prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_out').get() as { m: number }).m;
}

/** Count user-facing chat messages written after the given seq snapshot. */
export function countChatSendsSince(seq: number): number {
  return (
    getOutboundDb()
      .prepare(
        `SELECT COUNT(*) AS c FROM messages_out
         WHERE seq > ? AND kind = 'chat' AND deliver_after IS NULL AND recurrence IS NULL`,
      )
      .get(seq) as { c: number }
  ).c;
}

/** Get undelivered messages (for host polling — reads from outbound.db). */
export function getUndeliveredMessages(): MessageOutRow[] {
  return getOutboundDb()
    .prepare(
      `SELECT * FROM messages_out
       WHERE (deliver_after IS NULL OR deliver_after <= datetime('now'))
       ORDER BY timestamp ASC`,
    )
    .all() as MessageOutRow[];
}
