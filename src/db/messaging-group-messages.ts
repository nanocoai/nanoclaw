import { log } from '../log.js';
import { getDb } from './connection.js';

export const TEXT_CAP_PER_MSG = 500;
export const RETENTION_PER_GROUP = 5000;
export const HARD_CAP = 50;

export interface LogRow {
  id: number;
  messaging_group_id: string;
  thread_id: string | null;
  direction: 'in' | 'out';
  source_id: string | null;
  sender_name: string | null;
  sender_id: string | null;
  agent_group_id: string | null;
  text: string | null;
  has_attachments: number;
  ts: string;
}

export interface RecordIncomingArgs {
  messaging_group_id: string;
  thread_id: string | null;
  source_id: string | null;
  sender_name: string | null;
  sender_id: string | null;
  text: string | null;
  has_attachments: number;
  ts: string;
}

export interface RecordOutgoingArgs {
  messaging_group_id: string;
  thread_id: string | null;
  source_id: string | null;
  agent_group_id: string | null;
  text: string | null;
  has_attachments: number;
  ts: string;
}

function truncate(text: string | null): string | null {
  if (text == null) return null;
  if (text.length <= TEXT_CAP_PER_MSG) return text;
  return text.slice(0, TEXT_CAP_PER_MSG - 1) + '…';
}

export function recordIncomingMessage(args: RecordIncomingArgs): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO messaging_group_messages
        (messaging_group_id, thread_id, direction, source_id, sender_name, sender_id, agent_group_id, text, has_attachments, ts)
       VALUES (@messaging_group_id, @thread_id, 'in', @source_id, @sender_name, @sender_id, NULL, @text, @has_attachments, @ts)`,
    )
    .run({ ...args, text: truncate(args.text) });
}

export function recordOutgoingMessage(args: RecordOutgoingArgs): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO messaging_group_messages
        (messaging_group_id, thread_id, direction, source_id, sender_name, sender_id, agent_group_id, text, has_attachments, ts)
       VALUES (@messaging_group_id, @thread_id, 'out', @source_id, NULL, NULL, @agent_group_id, @text, @has_attachments, @ts)`,
    )
    .run({ ...args, text: truncate(args.text) });
}

export function findLogRowByPlatformId(
  messagingGroupId: string,
  sourceId: string,
  direction: 'in' | 'out',
): { id: number } | undefined {
  return getDb()
    .prepare('SELECT id FROM messaging_group_messages WHERE messaging_group_id = ? AND source_id = ? AND direction = ?')
    .get(messagingGroupId, sourceId, direction) as { id: number } | undefined;
}

export function fetchContextRows(
  messagingGroupId: string,
  threadId: string | null,
  afterId: number,
  beforeId: number,
  limit: number,
): LogRow[] {
  // Fetch the last `limit` rows in the (afterId, beforeId) window, then return
  // them oldest-first for prepending. Thread filter: if threadId is null, match
  // rows where thread_id IS NULL; otherwise match exact thread_id.
  const sql =
    threadId == null
      ? `SELECT * FROM messaging_group_messages
         WHERE messaging_group_id = ? AND thread_id IS NULL
           AND id > ? AND id < ?
         ORDER BY id DESC
         LIMIT ?`
      : `SELECT * FROM messaging_group_messages
         WHERE messaging_group_id = ? AND thread_id = ?
           AND id > ? AND id < ?
         ORDER BY id DESC
         LIMIT ?`;
  const params =
    threadId == null
      ? [messagingGroupId, afterId, beforeId, limit]
      : [messagingGroupId, threadId, afterId, beforeId, limit];
  const rows = getDb()
    .prepare(sql)
    .all(...params) as LogRow[];
  return rows.reverse();
}

export function getAgentMessageCursor(
  agentGroupId: string,
  messagingGroupId: string,
  threadKey: string,
): { last_seen_id: number } | undefined {
  return getDb()
    .prepare(
      'SELECT last_seen_id FROM agent_group_message_cursors WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_id = ?',
    )
    .get(agentGroupId, messagingGroupId, threadKey) as { last_seen_id: number } | undefined;
}

export function upsertAgentMessageCursor(
  agentGroupId: string,
  messagingGroupId: string,
  threadKey: string,
  lastSeenId: number,
): void {
  getDb()
    .prepare(
      `INSERT INTO agent_group_message_cursors (agent_group_id, messaging_group_id, thread_id, last_seen_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent_group_id, messaging_group_id, thread_id) DO UPDATE SET
         last_seen_id = excluded.last_seen_id,
         updated_at = excluded.updated_at
       WHERE excluded.last_seen_id > last_seen_id`,
    )
    .run(agentGroupId, messagingGroupId, threadKey, lastSeenId, new Date().toISOString());
}

/**
 * Per-messaging-group retention: keep the most recent RETENTION_PER_GROUP
 * rows, delete the rest. Cheap because the (messaging_group_id, id) index
 * lets the engine pick the cutoff with one ORDER BY scan per group.
 */
export function sweepRetention(): void {
  try {
    const db = getDb();
    const groups = db
      .prepare(
        `SELECT messaging_group_id, COUNT(*) AS n
           FROM messaging_group_messages
           GROUP BY messaging_group_id
           HAVING COUNT(*) > ?`,
      )
      .all(RETENTION_PER_GROUP) as { messaging_group_id: string; n: number }[];

    let total = 0;
    for (const g of groups) {
      const cutoff = db
        .prepare(
          `SELECT id FROM messaging_group_messages
             WHERE messaging_group_id = ?
             ORDER BY id DESC
             LIMIT 1 OFFSET ?`,
        )
        .get(g.messaging_group_id, RETENTION_PER_GROUP) as { id: number } | undefined;
      if (!cutoff) continue;
      const result = db
        .prepare('DELETE FROM messaging_group_messages WHERE messaging_group_id = ? AND id <= ?')
        .run(g.messaging_group_id, cutoff.id);
      total += result.changes;
    }

    if (total > 0) log.info('Pruned messaging_group_messages', { rows: total, groups: groups.length });
  } catch (err) {
    log.warn('messaging_group_messages retention sweep failed', { err });
  }
}
