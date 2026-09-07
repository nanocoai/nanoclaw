import {
  closeSessionDb,
  getInboundDb,
  sqliteClearContainerToolInFlight,
  sqliteClearStaleProcessingAcks,
  sqliteSetContainerToolInFlight,
} from './connection.js';
import {
  sqliteDeleteState,
  sqliteFindByName,
  sqliteFindByRouting,
  sqliteFindCliResponse,
  sqliteFindQuestionResponse,
  sqliteGetAllDestinations,
  sqliteGetMessageIn,
  sqliteGetMessageIdBySeq,
  sqliteGetPendingMessages,
  sqliteGetRoutingBySeq,
  sqliteGetSessionRouting,
  sqliteGetState,
  sqliteGetUndeliveredMessages,
  sqliteMarkCompleted,
  sqliteMarkFailed,
  sqliteMarkProcessing,
  sqliteMarkScriptSkipped,
  sqliteSetState,
  sqliteTimestamp,
  sqliteWriteMessageOut,
} from './operations.js';
import type { MessageInRow } from '../../db/messages-in.js';
import type { MessageOutRow } from '../../db/messages-out.js';
import {
  parseContainerRecord,
  parseInboundRecord,
  parseOutboundRecord,
  parseSessionRoutingRecord,
} from '../model.generated.js';
import type {
  AgentMailbox,
  InboundMessage,
  MailboxOperations,
  MailboxSessionKey,
  OutboundMessage,
  ProcessingStatus,
} from '../types.js';

function inboundMessage(row: MessageInRow): InboundMessage {
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

function outboundMessage(row: MessageOutRow): OutboundMessage {
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

function parseInboundMessage(row: MessageInRow): InboundMessage | undefined {
  try {
    return inboundMessage(row);
  } catch (error) {
    console.error(`[agent-runner] Skipping invalid inbound mailbox row ${row.id}: ${String(error)}`);
    return undefined;
  }
}

export class SqliteAgentMailbox implements AgentMailbox {
  readonly operations: MailboxOperations = this;

  shouldRestartAfter(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes('database disk image is malformed') ||
      message.includes('SQLITE_CORRUPT') ||
      message.includes('file is not a database')
    );
  }

  async start(_key: MailboxSessionKey | null): Promise<void> {}

  async run<T>(action: () => T | Promise<T>): Promise<T> {
    return action();
  }

  async stop(): Promise<void> {
    closeSessionDb();
  }

  getPendingMessages(limit: number, isFirstPoll: boolean): InboundMessage[] {
    return sqliteGetPendingMessages(isFirstPoll, limit).flatMap((row) => {
      const message = parseInboundMessage(row);
      return message ? [message] : [];
    });
  }

  markMessages(ids: string[], status: ProcessingStatus): void {
    if (status === 'processing') sqliteMarkProcessing(ids);
    else if (status === 'completed') sqliteMarkCompleted(ids);
    else if (status === 'failed') ids.forEach(sqliteMarkFailed);
    else sqliteMarkScriptSkipped(ids.map((id) => ({ id, reason: 'error' })));
  }

  markScriptSkipped(skips: Array<{ id: string; reason: string }>): void {
    sqliteMarkScriptSkipped(skips);
  }

  getMessageIn(id: string): InboundMessage | undefined {
    const row = sqliteGetMessageIn(id);
    return row && inboundMessage(row);
  }

  findQuestionResponse(questionId: string): InboundMessage | undefined {
    const row = sqliteFindQuestionResponse(questionId);
    return row && inboundMessage(row);
  }

  findCliResponse(requestId: string): InboundMessage | undefined {
    const row = sqliteFindCliResponse(requestId);
    return row && inboundMessage(row);
  }

  async writeMessageOut(message: Parameters<MailboxOperations['writeMessageOut']>[0]): Promise<number> {
    return sqliteWriteMessageOut(message);
  }

  getMessageIdBySeq(sequence: number): string | null {
    return sqliteGetMessageIdBySeq(sequence);
  }

  getRoutingBySeq(sequence: number) {
    const row = sqliteGetRoutingBySeq(sequence);
    return (
      row &&
      parseSessionRoutingRecord({
        channelType: row.channel_type,
        platformId: row.platform_id,
        threadId: row.thread_id,
      })
    );
  }

  getLatestInboundRoute(channelType: string, platformId: string) {
    const row = getInboundDb()
      .prepare(
        `SELECT id, thread_id FROM messages_in
         WHERE channel_type = ? AND platform_id = ?
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(channelType, platformId) as { id: string; thread_id: string | null } | undefined;
    return row ? { threadId: row.thread_id, inReplyTo: row.id } : null;
  }

  getUndeliveredMessages(): OutboundMessage[] {
    return sqliteGetUndeliveredMessages().map(outboundMessage);
  }

  getState(key: string) {
    return sqliteGetState(key);
  }

  setState(key: string, value: string): void {
    sqliteSetState(key, value);
  }

  deleteState(key: string): void {
    sqliteDeleteState(key);
  }

  getSessionRouting() {
    return sqliteGetSessionRouting();
  }

  getDestinations() {
    return sqliteGetAllDestinations();
  }

  findDestinationByName(name: string) {
    return sqliteFindByName(name);
  }

  findDestinationByRouting(channelType: string, platformId: string) {
    return sqliteFindByRouting(channelType, platformId);
  }

  setContainerToolInFlight(tool: string, declaredTimeoutMs: number | null): void {
    const timeout =
      declaredTimeoutMs !== null && Number.isSafeInteger(declaredTimeoutMs) && declaredTimeoutMs >= 0
        ? declaredTimeoutMs
        : null;
    const record = parseContainerRecord({
      currentTool: tool,
      toolDeclaredTimeoutMs: timeout,
      toolStartedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    sqliteSetContainerToolInFlight(record.currentTool!, record.toolDeclaredTimeoutMs);
  }

  clearContainerToolInFlight = sqliteClearContainerToolInFlight;
  clearStaleProcessingAcks = sqliteClearStaleProcessingAcks;
}
