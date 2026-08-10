/**
 * Outbound message operations (container side).
 *
 * Writes to outbound.db (container-owned).
 * The host polls this DB (read-only) for undelivered messages.
 */
import { createHash } from 'node:crypto';

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

export interface WriteChatMessageOnce {
  id: string;
  in_reply_to?: string | null;
  platform_id?: string | null;
  channel_type?: string | null;
  thread_id?: string | null;
  text: string;
}

export interface WriteMessageOnceResult {
  id: string;
  seq: number;
  inserted: boolean;
}

export type ChatDeliverySource = 'mcp' | 'final' | 'error';

function nextOutboundSeq(): number {
  const outbound = getOutboundDb();
  const inbound = getInboundDb();
  const maxOut = (outbound.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_out').get() as { m: number }).m;
  const maxIn = (inbound.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
  const max = Math.max(maxOut, maxIn);
  return max % 2 === 0 ? max + 1 : max + 2;
}

function insertMessageOut(msg: WriteMessageOut, seq: number): void {
  getOutboundDb()
    .prepare(
      `INSERT INTO messages_out (id, seq, in_reply_to, timestamp, deliver_after, recurrence, kind, platform_id, channel_type, thread_id, content)
       VALUES ($id, $seq, $in_reply_to, $timestamp, $deliver_after, $recurrence, $kind, $platform_id, $channel_type, $thread_id, $content)`,
    )
    .run({
      $id: msg.id,
      $seq: seq,
      $timestamp: new Date().toISOString(),
      $in_reply_to: msg.in_reply_to ?? null,
      $deliver_after: msg.deliver_after ?? null,
      $recurrence: msg.recurrence ?? null,
      $kind: msg.kind,
      $platform_id: msg.platform_id ?? null,
      $channel_type: msg.channel_type ?? null,
      $thread_id: msg.thread_id ?? null,
      $content: msg.content,
    });
}

function inImmediateTransaction<T>(fn: () => T): T {
  const outbound = getOutboundDb();
  outbound.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    outbound.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      outbound.exec('ROLLBACK');
    } catch {
      // Preserve the original write failure if SQLite already rolled back.
    }
    throw err;
  }
}

function normalizeChatText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
}

function chatFingerprint(msg: WriteChatMessageOnce): string {
  // Thread routing can be resolved through different snapshots by the MCP and
  // final-result processes. The logical destination is the channel/platform;
  // keying on it catches the double-door delivery without content-window
  // heuristics or suppressing the same reply on a later inbound turn.
  const canonical = JSON.stringify({
    kind: 'chat',
    channelType: msg.channel_type ?? null,
    platformId: msg.platform_id ?? null,
    text: normalizeChatText(msg.text),
  });
  return createHash('sha256').update(canonical).digest('hex');
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
 */
export function writeMessageOut(msg: WriteMessageOut): number {
  return inImmediateTransaction(() => {
    const seq = nextOutboundSeq();
    insertMessageOut(msg, seq);
    return seq;
  });
}

/**
 * Write one plain chat message per (inbound turn, logical destination, text).
 * The durable claim and messages_out row share a SQLite transaction, making
 * retries and the separate MCP subprocess safe without relying on timing.
 */
export function writeChatMessageOnce(
  msg: WriteChatMessageOnce,
  turnId: string,
  source: ChatDeliverySource,
): WriteMessageOnceResult {
  return inImmediateTransaction(() => {
    const outbound = getOutboundDb();
    const fingerprint = chatFingerprint(msg);
    const claim = outbound
      .prepare(
        `INSERT OR IGNORE INTO message_delivery_claims
           (turn_id, fingerprint, message_out_id, source, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(turnId, fingerprint, msg.id, source, new Date().toISOString());

    if (claim.changes === 0) {
      const existing = outbound
        .prepare(
          `SELECT c.message_out_id AS id, m.seq AS seq
           FROM message_delivery_claims c
           JOIN messages_out m ON m.id = c.message_out_id
           WHERE c.turn_id = ? AND c.fingerprint = ?`,
        )
        .get(turnId, fingerprint) as { id: string; seq: number } | undefined;
      if (!existing) {
        throw new Error(`delivery claim invariant violated for turn ${turnId}`);
      }
      return { ...existing, inserted: false };
    }

    const seq = nextOutboundSeq();
    insertMessageOut(
      {
        id: msg.id,
        in_reply_to: msg.in_reply_to,
        kind: 'chat',
        platform_id: msg.platform_id,
        channel_type: msg.channel_type,
        thread_id: msg.thread_id,
        content: JSON.stringify({ text: msg.text }),
      },
      seq,
    );
    return { id: msg.id, seq, inserted: true };
  });
}

/** True when any plain chat content has already been delivered for a turn. */
export function hasChatDeliveryForTurn(turnId: string): boolean {
  const row = getOutboundDb()
    .prepare('SELECT 1 AS found FROM message_delivery_claims WHERE turn_id = ? LIMIT 1')
    .get(turnId) as { found: number } | null | undefined;
  return Boolean(row);
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
  const inRow = inbound.prepare('SELECT id FROM messages_in WHERE seq = ?').get(seq) as { id: string } | undefined;
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

/** Get undelivered messages (for host polling — reads from outbound.db). */
export function getUndeliveredMessages(): MessageOutRow[] {
  return getOutboundDb()
    .prepare(
      `SELECT * FROM messages_out
       WHERE (deliver_after IS NULL OR datetime(deliver_after) <= datetime('now'))
       ORDER BY timestamp ASC`,
    )
    .all() as MessageOutRow[];
}
