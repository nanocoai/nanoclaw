import type { Database } from 'bun:sqlite';

import { getOutboundDb, readInbound } from './connection.js';
import type { MessageInRow } from '../../db/messages-in.js';
import type { MessageOutRow } from '../../db/messages-out.js';
import {
  createOutboundRecord,
  parseDestinationRecord,
  parseSessionRoutingRecord,
  parseStateRecord,
} from '../model.generated.js';
import type { Destination, OutboundWrite, SessionRouting, StateValue } from '../types.js';

let hasOnWake: boolean | null = null;

const SQLITE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

export function sqliteTimestamp(value: string): string {
  const source = SQLITE_TIMESTAMP.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const milliseconds = Date.parse(source);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : value;
}

function hasOnWakeColumn(db: Database): boolean {
  if (hasOnWake !== null) return hasOnWake;
  const columns = db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>;
  hasOnWake = columns.some(({ name }) => name === 'on_wake');
  return hasOnWake;
}

export function sqliteGetPendingMessages(isFirstPoll: boolean, limit: number): MessageInRow[] {
  const pending = readInbound((inbound) => {
    const onWakeFilter = hasOnWakeColumn(inbound) ? 'AND (on_wake = 0 OR ?1 = 1)' : '';
    return inbound
      .prepare(
        `SELECT * FROM messages_in
         WHERE status = 'pending'
           AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))
           ${onWakeFilter}
         ORDER BY seq ASC`,
      )
      .all(isFirstPoll ? 1 : 0) as MessageInRow[];
  });
  if (pending.length === 0) return [];
  const acked = new Set(
    (getOutboundDb().prepare('SELECT message_id FROM processing_ack').all() as Array<{ message_id: string }>).map(
      ({ message_id }) => message_id,
    ),
  );
  const unclaimed = pending.filter(({ id }) => !acked.has(id));
  const wake = unclaimed.filter(({ trigger }) => trigger === 1).slice(0, limit);
  const remaining = limit - wake.length;
  const context = remaining > 0 ? unclaimed.filter(({ trigger }) => trigger === 0).slice(-remaining) : [];
  return [...wake, ...context].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

function mark(ids: string[], status: string): void {
  if (ids.length === 0) return;
  const statement = getOutboundDb().prepare(
    'INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)',
  );
  getOutboundDb().transaction(() => {
    for (const id of ids) statement.run(id, status, new Date().toISOString());
  })();
}

export function sqliteMarkProcessing(ids: string[]): void {
  mark(ids, 'processing');
}

export function sqliteMarkCompleted(ids: string[]): void {
  mark(ids, 'completed');
}

export function sqliteMarkFailed(id: string): void {
  mark([id], 'failed');
}

export function sqliteMarkScriptSkipped(skips: Array<{ id: string; reason: string }>): void {
  if (skips.length === 0) return;
  const db = getOutboundDb();
  const statement = db.prepare(
    'INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)',
  );
  db.transaction(() => {
    for (const skip of skips) {
      statement.run(skip.id, skip.reason === 'error' ? 'script-skip:error' : 'completed', new Date().toISOString());
    }
  })();
}

export function sqliteGetMessageIn(id: string): MessageInRow | undefined {
  return readInbound(
    (inbound) => inbound.prepare('SELECT * FROM messages_in WHERE id = ?').get(id) as MessageInRow | undefined,
  );
}

export function sqliteFindQuestionResponse(questionId: string): MessageInRow | undefined {
  const response = readInbound(
    (inbound) =>
      inbound
        .prepare("SELECT * FROM messages_in WHERE status = 'pending' AND content LIKE ?")
        .get(`%"questionId":"${questionId}"%`) as MessageInRow | undefined,
  );
  if (!response) return undefined;
  const acknowledged = getOutboundDb().prepare('SELECT 1 FROM processing_ack WHERE message_id = ?').get(response.id);
  return acknowledged ? undefined : response;
}

export function sqliteFindCliResponse(requestId: string): MessageInRow | undefined {
  return readInbound(
    (inbound) =>
      inbound
        .prepare("SELECT * FROM messages_in WHERE status = 'pending' AND content LIKE ?")
        .get(`%"requestId":"${requestId}"%`) as MessageInRow | undefined,
  );
}

export function sqliteWriteMessageOut(message: OutboundWrite): number {
  const outbound = getOutboundDb();
  outbound.exec('BEGIN IMMEDIATE');
  try {
    const maxOut = (
      outbound.prepare('SELECT COALESCE(MAX(seq), 0) AS value FROM messages_out').get() as {
        value: number;
      }
    ).value;
    const maxIn = readInbound(
      (inbound) =>
        (inbound.prepare('SELECT COALESCE(MAX(seq), 0) AS value FROM messages_in').get() as { value: number }).value,
    );
    const max = Math.max(maxOut, maxIn);
    const sequence = max % 2 === 0 ? max + 1 : max + 2;
    const record = createOutboundRecord(message, sequence, new Date().toISOString());
    outbound
      .prepare(
        `INSERT INTO messages_out
           (id, seq, in_reply_to, timestamp, deliver_after, recurrence, kind, platform_id, channel_type, thread_id, content)
         VALUES
           ($id, $seq, $in_reply_to, $timestamp, $deliver_after, $recurrence, $kind, $platform_id, $channel_type, $thread_id, $content)`,
      )
      .run({
        $id: record.id,
        $seq: record.sequence,
        $timestamp: record.timestamp,
        $in_reply_to: record.inReplyTo,
        $deliver_after: record.deliverAfter,
        $recurrence: record.recurrence,
        $kind: record.kind,
        $platform_id: record.platformId,
        $channel_type: record.channelType,
        $thread_id: record.threadId,
        $content: record.content,
      });
    outbound.exec('COMMIT');
    return sequence;
  } catch (error) {
    outbound.exec('ROLLBACK');
    throw error;
  }
}

export function sqliteGetMessageIdBySeq(sequence: number): string | null {
  const inboundRow = readInbound(
    (inbound) =>
      inbound.prepare('SELECT id FROM messages_in WHERE seq = ?').get(sequence) as { id: string } | undefined,
  );
  if (inboundRow) return inboundRow.id;
  const outboundRow = getOutboundDb().prepare('SELECT id FROM messages_out WHERE seq = ?').get(sequence) as
    | { id: string }
    | undefined;
  if (!outboundRow) return null;
  const delivered = readInbound(
    (inbound) =>
      inbound.prepare('SELECT platform_message_id FROM delivered WHERE message_out_id = ?').get(outboundRow.id) as
        | { platform_message_id: string | null }
        | undefined,
  );
  return delivered?.platform_message_id || outboundRow.id;
}

export function sqliteGetDeliveryStatus(messageOutId: string): 'delivered' | 'failed' | null {
  const row = readInbound(
    (inbound) =>
      inbound.prepare('SELECT status FROM delivered WHERE message_out_id = ?').get(messageOutId) as
        | { status: string }
        | undefined,
  );
  if (!row) return null;
  return row.status === 'failed' ? 'failed' : 'delivered';
}

export function sqliteGetRoutingBySeq(
  sequence: number,
): { channel_type: string | null; platform_id: string | null; thread_id: string | null } | null {
  const inbound = readInbound(
    (db) =>
      db.prepare('SELECT channel_type, platform_id, thread_id FROM messages_in WHERE seq = ?').get(sequence) as
        | { channel_type: string | null; platform_id: string | null; thread_id: string | null }
        | undefined,
  );
  if (inbound) return inbound;
  return (
    (getOutboundDb()
      .prepare('SELECT channel_type, platform_id, thread_id FROM messages_out WHERE seq = ?')
      .get(sequence) as
      | { channel_type: string | null; platform_id: string | null; thread_id: string | null }
      | undefined) ?? null
  );
}

export function sqliteGetUndeliveredMessages(): MessageOutRow[] {
  return getOutboundDb()
    .prepare(
      `SELECT * FROM messages_out
       WHERE (deliver_after IS NULL OR datetime(deliver_after) <= datetime('now'))
       ORDER BY timestamp ASC`,
    )
    .all() as MessageOutRow[];
}

export function sqliteGetSessionRouting(): SessionRouting {
  const row = readInbound((db) => {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'session_routing'").get();
    if (!exists) return undefined;
    return db.prepare('SELECT channel_type, platform_id, thread_id FROM session_routing WHERE id = 1').get() as
      | { channel_type: string | null; platform_id: string | null; thread_id: string | null }
      | undefined;
  });
  return parseSessionRoutingRecord({
    channelType: row?.channel_type ?? null,
    platformId: row?.platform_id ?? null,
    threadId: row?.thread_id ?? null,
  });
}

export function sqliteGetState(key: string): StateValue | undefined {
  const row = getOutboundDb().prepare('SELECT value, updated_at FROM session_state WHERE key = ?').get(key) as
    | { value: string; updated_at: string }
    | undefined;
  if (!row) return undefined;
  const record = parseStateRecord({ key, value: row.value, updatedAt: sqliteTimestamp(row.updated_at) });
  return { value: record.value, updatedAt: record.updatedAt };
}

export function sqliteSetState(key: string, value: string): void {
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, value, new Date().toISOString());
}

export function sqliteDeleteState(key: string): void {
  getOutboundDb().prepare('DELETE FROM session_state WHERE key = ?').run(key);
}

interface DestinationRow {
  name: string;
  display_name: string | null;
  type: 'channel' | 'agent';
  channel_type: string | null;
  platform_id: string | null;
  agent_group_id: string | null;
}

function destination(row: DestinationRow): Destination {
  return parseDestinationRecord({
    name: row.name,
    displayName: row.display_name,
    type: row.type,
    channelType: row.channel_type,
    platformId: row.platform_id,
    agentGroupId: row.agent_group_id,
  });
}

export function sqliteGetAllDestinations(): Destination[] {
  return readInbound((db) => db.prepare('SELECT * FROM destinations ORDER BY name').all() as DestinationRow[]).map(
    destination,
  );
}

export function sqliteFindByName(name: string): Destination | undefined {
  const row = readInbound(
    (db) => db.prepare('SELECT * FROM destinations WHERE name = ?').get(name) as DestinationRow | undefined,
  );
  return row && destination(row);
}

export function sqliteFindByRouting(channelType: string, platformId: string): Destination | undefined {
  const row = readInbound((db) =>
    channelType === 'agent'
      ? (db.prepare("SELECT * FROM destinations WHERE type = 'agent' AND agent_group_id = ?").get(platformId) as
          | DestinationRow
          | undefined)
      : (db
          .prepare("SELECT * FROM destinations WHERE type = 'channel' AND channel_type = ? AND platform_id = ?")
          .get(channelType, platformId) as DestinationRow | undefined),
  );
  return row && destination(row);
}
