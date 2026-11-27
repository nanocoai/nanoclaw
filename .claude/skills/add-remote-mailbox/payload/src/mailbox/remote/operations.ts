/**
 * Host-side execution of the runner's `MailboxOperations` against one
 * session's inbound.db / outbound.db.
 *
 * Ported from container/agent-runner/src/mailbox/sqlite/{index,operations,connection}.ts
 * (bun:sqlite) to better-sqlite3. Semantics are intentionally identical:
 * odd seq for messages_out, the same record parsing, the same timestamps.
 * Handles are opened per operation and closed after, like the rest of the host.
 */
import Database from 'better-sqlite3';
import fs from 'fs';

import { log } from '../../log.js';
import {
  createOutboundRecord,
  parseContainerRecord,
  parseDestinationRecord,
  parseInboundRecord,
  parseOutboundRecord,
  parseSessionRoutingRecord,
  parseStateRecord,
} from '../model.js';
import type { InboundRecord, OutboundRecord, ProcessingStatus } from '../model.js';
import { inboundDbPath, outboundDbPath } from '../sqlite/paths.js';
import { OUTBOUND_SCHEMA } from '../sqlite/schema.js';
import type { RemoteSessionKey } from './ids.js';

const SQLITE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

export function sqliteTimestamp(value: string): string {
  const source = SQLITE_TIMESTAMP.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const milliseconds = Date.parse(source);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : value;
}

interface MessageInRow {
  id: string;
  seq: number | null;
  kind: string;
  timestamp: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  series_id: string | null;
  tries: number;
  trigger: number;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
  source_session_id: string | null;
  on_wake?: number;
}

interface MessageOutRow {
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

interface DestinationRow {
  name: string;
  display_name: string | null;
  type: 'channel' | 'agent';
  channel_type: string | null;
  platform_id: string | null;
  agent_group_id: string | null;
}

type RoutingRow = { channel_type: string | null; platform_id: string | null; thread_id: string | null };

function inboundMessage(row: MessageInRow): InboundRecord {
  return parseInboundRecord({
    id: row.id,
    sequence: row.seq,
    kind: row.kind,
    timestamp: sqliteTimestamp(row.timestamp),
    status: row.status,
    processAfter: row.process_after === null ? null : sqliteTimestamp(row.process_after),
    recurrence: row.recurrence,
    seriesId: row.series_id ?? null,
    tries: row.tries,
    trigger: row.trigger === 1,
    platformId: row.platform_id,
    channelType: row.channel_type,
    threadId: row.thread_id,
    content: row.content,
    sourceSessionId: row.source_session_id ?? null,
    onWake: row.on_wake === 1,
  });
}

function outboundMessage(row: MessageOutRow): OutboundRecord {
  return parseOutboundRecord({
    id: row.id,
    sequence: row.seq,
    inReplyTo: row.in_reply_to,
    timestamp: sqliteTimestamp(row.timestamp),
    deliverAfter: row.deliver_after === null ? null : sqliteTimestamp(row.deliver_after),
    recurrence: row.recurrence,
    kind: row.kind,
    platformId: row.platform_id,
    channelType: row.channel_type,
    threadId: row.thread_id,
    content: row.content,
  });
}

function destination(row: DestinationRow) {
  return parseDestinationRecord({
    name: row.name,
    displayName: row.display_name,
    type: row.type,
    channelType: row.channel_type,
    platformId: row.platform_id,
    agentGroupId: row.agent_group_id,
  });
}

/** Thrown when a session's DB files do not exist (session gone or never created). */
export class SessionUnavailableError extends Error {
  constructor(message = 'session mailbox unavailable') {
    super(message);
    this.name = 'SessionUnavailableError';
  }
}

export interface SessionOperations {
  getPendingMessages(limit: number, isFirstPoll: boolean): InboundRecord[];
  markMessages(ids: string[], status: ProcessingStatus): void;
  markScriptSkipped(skips: Array<{ id: string; reason: string }>): void;
  getMessageIn(id: string): InboundRecord | undefined;
  findQuestionResponse(questionId: string): InboundRecord | undefined;
  findCliResponse(requestId: string): InboundRecord | undefined;
  writeMessageOut(draft: Parameters<typeof createOutboundRecord>[0]): number;
  getMessageIdBySeq(sequence: number): string | null;
  getRoutingBySeq(sequence: number): ReturnType<typeof parseSessionRoutingRecord> | null;
  getLatestInboundRoute(channelType: string, platformId: string): { threadId: string | null; inReplyTo: string } | null;
  getUndeliveredMessages(): OutboundRecord[];
  getDeliveryStatus(messageOutId: string): 'delivered' | 'failed' | null;
  getState(key: string): { value: string; updatedAt: string } | undefined;
  setState(key: string, value: string): void;
  deleteState(key: string): void;
  getSessionRouting(): ReturnType<typeof parseSessionRoutingRecord>;
  getDestinations(): ReturnType<typeof destination>[];
  findDestinationByName(name: string): ReturnType<typeof destination> | undefined;
  findDestinationByRouting(channelType: string, platformId: string): ReturnType<typeof destination> | undefined;
  setContainerToolInFlight(tool: string, declaredTimeoutMs: number | null): void;
  clearContainerToolInFlight(): void;
  clearStaleProcessingAcks(): void;
}

function withInbound<T>(key: RemoteSessionKey, read: (db: Database.Database) => T): T {
  const file = inboundDbPath(key.agentGroupId, key.sessionId);
  if (!fs.existsSync(file)) throw new SessionUnavailableError();
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    return read(db);
  } finally {
    db.close();
  }
}

function withOutbound<T>(key: RemoteSessionKey, run: (db: Database.Database) => T): T {
  const file = outboundDbPath(key.agentGroupId, key.sessionId);
  if (!fs.existsSync(file)) throw new SessionUnavailableError();
  const db = new Database(file, { fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    db.pragma('journal_mode = DELETE');
    db.pragma('foreign_keys = ON');
    // Forward-compat for older outbound.db files (session_state / container_state added later).
    db.exec(OUTBOUND_SCHEMA);
    return run(db);
  } finally {
    db.close();
  }
}

function mark(key: RemoteSessionKey, ids: string[], status: string): void {
  if (ids.length === 0) return;
  withOutbound(key, (db) => {
    const statement = db.prepare(
      'INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)',
    );
    db.transaction(() => {
      for (const id of ids) statement.run(id, status, new Date().toISOString());
    })();
  });
}

function markSkips(key: RemoteSessionKey, skips: Array<{ id: string; reason: string }>): void {
  if (skips.length === 0) return;
  withOutbound(key, (db) => {
    const statement = db.prepare(
      'INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)',
    );
    db.transaction(() => {
      for (const skip of skips) {
        statement.run(skip.id, skip.reason === 'error' ? 'script-skip:error' : 'completed', new Date().toISOString());
      }
    })();
  });
}

export function createSessionOperations(key: RemoteSessionKey): SessionOperations {
  const ops: SessionOperations = {
    getPendingMessages(limit, isFirstPoll) {
      const pending = withInbound(key, (inbound) => {
        const hasOnWake = (inbound.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).some(
          ({ name }) => name === 'on_wake',
        );
        const onWakeFilter = hasOnWake ? 'AND (on_wake = 0 OR ? = 1)' : '';
        return inbound
          .prepare(
            `SELECT * FROM messages_in
             WHERE status = 'pending'
               AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))
               ${onWakeFilter}
             ORDER BY seq ASC`,
          )
          .all(...(hasOnWake ? [isFirstPoll ? 1 : 0] : [])) as MessageInRow[];
      });
      if (pending.length === 0) return [];
      const acked = new Set(
        withOutbound(
          key,
          (db) => db.prepare('SELECT message_id FROM processing_ack').all() as Array<{ message_id: string }>,
        ).map(({ message_id }) => message_id),
      );
      const unclaimed = pending.filter(({ id }) => !acked.has(id));
      const wake = unclaimed.filter(({ trigger }) => trigger === 1).slice(0, limit);
      const remaining = limit - wake.length;
      const context = remaining > 0 ? unclaimed.filter(({ trigger }) => trigger === 0).slice(-remaining) : [];
      return [...wake, ...context]
        .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
        .flatMap((row) => {
          try {
            return [inboundMessage(row)];
          } catch (error) {
            log.error('Skipping invalid inbound mailbox row', { id: row.id, err: String(error) });
            return [];
          }
        });
    },

    markMessages(ids, status) {
      if (status === 'processing' || status === 'completed' || status === 'failed') mark(key, ids, status);
      else
        markSkips(
          key,
          ids.map((id) => ({ id, reason: 'error' })),
        );
    },

    markScriptSkipped(skips) {
      markSkips(key, skips);
    },

    getMessageIn(id) {
      const row = withInbound(
        key,
        (db) => db.prepare('SELECT * FROM messages_in WHERE id = ?').get(id) as MessageInRow | undefined,
      );
      return row && inboundMessage(row);
    },

    findQuestionResponse(questionId) {
      const response = withInbound(
        key,
        (db) =>
          db
            .prepare("SELECT * FROM messages_in WHERE status = 'pending' AND content LIKE ?")
            .get(`%"questionId":"${questionId}"%`) as MessageInRow | undefined,
      );
      if (!response) return undefined;
      const acknowledged = withOutbound(key, (db) =>
        db.prepare('SELECT 1 FROM processing_ack WHERE message_id = ?').get(response.id),
      );
      return acknowledged ? undefined : inboundMessage(response);
    },

    findCliResponse(requestId) {
      const row = withInbound(
        key,
        (db) =>
          db
            .prepare("SELECT * FROM messages_in WHERE status = 'pending' AND content LIKE ?")
            .get(`%"requestId":"${requestId}"%`) as MessageInRow | undefined,
      );
      return row && inboundMessage(row);
    },

    writeMessageOut(draft) {
      const maxIn = withInbound(
        key,
        (db) => (db.prepare('SELECT COALESCE(MAX(seq), 0) AS value FROM messages_in').get() as { value: number }).value,
      );
      return withOutbound(key, (db) =>
        db
          .transaction(() => {
            const maxOut = (
              db.prepare('SELECT COALESCE(MAX(seq), 0) AS value FROM messages_out').get() as { value: number }
            ).value;
            const max = Math.max(maxOut, maxIn);
            const sequence = max % 2 === 0 ? max + 1 : max + 2;
            const record = createOutboundRecord(draft, sequence, new Date().toISOString());
            // A client retrying after a lost response resends the same draft: answer with the
            // sequence already allocated rather than inserting twice or failing on the unique id.
            const existing = db.prepare('SELECT seq FROM messages_out WHERE id = ?').get(record.id) as
              { seq: number | null } | undefined;
            if (existing && existing.seq !== null) return existing.seq;
            db.prepare(
              `INSERT INTO messages_out
                 (id, seq, in_reply_to, timestamp, deliver_after, recurrence, kind, platform_id, channel_type, thread_id, content)
               VALUES
                 (@id, @seq, @in_reply_to, @timestamp, @deliver_after, @recurrence, @kind, @platform_id, @channel_type, @thread_id, @content)`,
            ).run({
              id: record.id,
              seq: record.sequence,
              timestamp: record.timestamp,
              in_reply_to: record.inReplyTo,
              deliver_after: record.deliverAfter,
              recurrence: record.recurrence,
              kind: record.kind,
              platform_id: record.platformId,
              channel_type: record.channelType,
              thread_id: record.threadId,
              content: record.content,
            });
            return sequence;
          })
          .immediate(),
      );
    },

    getMessageIdBySeq(sequence) {
      const inboundRow = withInbound(
        key,
        (db) => db.prepare('SELECT id FROM messages_in WHERE seq = ?').get(sequence) as { id: string } | undefined,
      );
      if (inboundRow) return inboundRow.id;
      const outboundRow = withOutbound(
        key,
        (db) => db.prepare('SELECT id FROM messages_out WHERE seq = ?').get(sequence) as { id: string } | undefined,
      );
      if (!outboundRow) return null;
      const delivered = withInbound(
        key,
        (db) =>
          db.prepare('SELECT platform_message_id FROM delivered WHERE message_out_id = ?').get(outboundRow.id) as
            { platform_message_id: string | null } | undefined,
      );
      return delivered?.platform_message_id || outboundRow.id;
    },

    getRoutingBySeq(sequence) {
      const row =
        withInbound(
          key,
          (db) =>
            db.prepare('SELECT channel_type, platform_id, thread_id FROM messages_in WHERE seq = ?').get(sequence) as
              RoutingRow | undefined,
        ) ??
        withOutbound(
          key,
          (db) =>
            db.prepare('SELECT channel_type, platform_id, thread_id FROM messages_out WHERE seq = ?').get(sequence) as
              RoutingRow | undefined,
        );
      return row
        ? parseSessionRoutingRecord({
            channelType: row.channel_type,
            platformId: row.platform_id,
            threadId: row.thread_id,
          })
        : null;
    },

    getLatestInboundRoute(channelType, platformId) {
      const row = withInbound(
        key,
        (db) =>
          db
            .prepare(
              `SELECT id, thread_id FROM messages_in
               WHERE channel_type = ? AND platform_id = ?
               ORDER BY seq DESC LIMIT 1`,
            )
            .get(channelType, platformId) as { id: string; thread_id: string | null } | undefined,
      );
      return row ? { threadId: row.thread_id, inReplyTo: row.id } : null;
    },

    getUndeliveredMessages() {
      return withOutbound(
        key,
        (db) =>
          db
            .prepare(
              `SELECT * FROM messages_out
               WHERE (deliver_after IS NULL OR datetime(deliver_after) <= datetime('now'))
               ORDER BY timestamp ASC`,
            )
            .all() as MessageOutRow[],
      ).map(outboundMessage);
    },

    getDeliveryStatus(messageOutId) {
      const row = withInbound(
        key,
        (db) =>
          db.prepare('SELECT status FROM delivered WHERE message_out_id = ?').get(messageOutId) as
            { status: string } | undefined,
      );
      if (!row) return null;
      return row.status === 'failed' ? 'failed' : 'delivered';
    },

    getState(stateKey) {
      const row = withOutbound(
        key,
        (db) =>
          db.prepare('SELECT value, updated_at FROM session_state WHERE key = ?').get(stateKey) as
            { value: string; updated_at: string } | undefined,
      );
      if (!row) return undefined;
      const record = parseStateRecord({ key: stateKey, value: row.value, updatedAt: sqliteTimestamp(row.updated_at) });
      return { value: record.value, updatedAt: record.updatedAt };
    },

    setState(stateKey, value) {
      withOutbound(key, (db) =>
        db
          .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
          .run(stateKey, value, new Date().toISOString()),
      );
    },

    deleteState(stateKey) {
      withOutbound(key, (db) => db.prepare('DELETE FROM session_state WHERE key = ?').run(stateKey));
    },

    getSessionRouting() {
      const row = withInbound(key, (db) => {
        const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'session_routing'").get();
        if (!exists) return undefined;
        return db.prepare('SELECT channel_type, platform_id, thread_id FROM session_routing WHERE id = 1').get() as
          RoutingRow | undefined;
      });
      return parseSessionRoutingRecord({
        channelType: row?.channel_type ?? null,
        platformId: row?.platform_id ?? null,
        threadId: row?.thread_id ?? null,
      });
    },

    getDestinations() {
      return withInbound(
        key,
        (db) => db.prepare('SELECT * FROM destinations ORDER BY name').all() as DestinationRow[],
      ).map(destination);
    },

    findDestinationByName(name) {
      const row = withInbound(
        key,
        (db) => db.prepare('SELECT * FROM destinations WHERE name = ?').get(name) as DestinationRow | undefined,
      );
      return row && destination(row);
    },

    findDestinationByRouting(channelType, platformId) {
      const row = withInbound(key, (db) =>
        channelType === 'agent'
          ? (db.prepare("SELECT * FROM destinations WHERE type = 'agent' AND agent_group_id = ?").get(platformId) as
              DestinationRow | undefined)
          : (db
              .prepare("SELECT * FROM destinations WHERE type = 'channel' AND channel_type = ? AND platform_id = ?")
              .get(channelType, platformId) as DestinationRow | undefined),
      );
      return row && destination(row);
    },

    setContainerToolInFlight(tool, declaredTimeoutMs) {
      const timeout =
        declaredTimeoutMs !== null && Number.isSafeInteger(declaredTimeoutMs) && declaredTimeoutMs >= 0
          ? declaredTimeoutMs
          : null;
      const now = new Date().toISOString();
      const record = parseContainerRecord({
        currentTool: tool,
        toolDeclaredTimeoutMs: timeout,
        toolStartedAt: now,
        updatedAt: now,
      });
      withOutbound(key, (db) =>
        db
          .prepare(
            `INSERT INTO container_state (id, current_tool, tool_declared_timeout_ms, tool_started_at, updated_at)
             VALUES (1, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               current_tool = excluded.current_tool,
               tool_declared_timeout_ms = excluded.tool_declared_timeout_ms,
               tool_started_at = excluded.tool_started_at,
               updated_at = excluded.updated_at`,
          )
          .run(record.currentTool, record.toolDeclaredTimeoutMs, now, now),
      );
    },

    clearContainerToolInFlight() {
      withOutbound(key, (db) =>
        db
          .prepare(
            `INSERT INTO container_state (id, current_tool, tool_declared_timeout_ms, tool_started_at, updated_at)
             VALUES (1, NULL, NULL, NULL, ?)
             ON CONFLICT(id) DO UPDATE SET
               current_tool = NULL,
               tool_declared_timeout_ms = NULL,
               tool_started_at = NULL,
               updated_at = excluded.updated_at`,
          )
          .run(new Date().toISOString()),
      );
    },

    clearStaleProcessingAcks() {
      withOutbound(key, (db) => db.prepare("DELETE FROM processing_ack WHERE status = 'processing'").run());
    },
  };
  return ops;
}
