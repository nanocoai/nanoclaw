import type {
  DirectOutboundMessage,
  InboundMailbox,
  InboundMessage,
  MailboxHistoryMessage,
  MailboxTimelineMessage,
  OutboundMailbox,
  Task,
  TaskRecord,
  TaskStats,
  TaskUpdate,
} from '../../mailbox/types.js';
import {
  createInboundRecord,
  createTaskInboundRecord,
  outboundDelivery,
  parseIsoTimestamp,
  parseTaskRecord,
} from '../../mailbox/model.js';
import type {
  ContainerRecord,
  DeliveryRecord,
  DestinationRecord,
  InboundRecord,
  OutboundRecord,
  ProcessingAckRecord,
  SessionRoutingRecord,
  StateRecord,
} from '../../mailbox/model.js';

export interface InboundData {
  messages: Map<string, InboundRecord>;
  deliveries: Map<string, DeliveryRecord>;
  destinations: Map<string, DestinationRecord>;
  routing: Map<string, SessionRoutingRecord>;
  transaction<T>(fn: () => T): T;
}

export interface OutboundData {
  messages: Map<string, OutboundRecord>;
  acknowledgements: Map<string, ProcessingAckRecord>;
  state: Map<string, StateRecord>;
  container: Map<string, ContainerRecord>;
  transaction<T>(fn: () => T): T;
}

function due(value: string | null): boolean {
  if (value === null) return true;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

function future(value: string | null, now: number): boolean {
  if (value === null) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > now;
}

function insert<T>(records: Map<string, T>, id: string, record: T): void {
  if (records.has(id)) throw new Error(`duplicate mailbox record: ${id}`);
  records.set(id, record);
}

function liveTask(message: InboundRecord, taskId?: string): boolean {
  return (
    message.kind === 'task' &&
    (message.status === 'pending' || message.status === 'paused') &&
    (taskId === undefined || message.id === taskId || message.seriesId === taskId)
  );
}

function sequence(message: InboundRecord): number {
  if (message.sequence === null) throw new Error(`task mailbox record has no sequence: ${message.id}`);
  return message.sequence;
}

function seriesId(message: InboundRecord): string {
  if (message.seriesId === null) throw new Error(`task mailbox record has no series id: ${message.id}`);
  return message.seriesId;
}

function changeTasks(
  records: InboundData,
  match: (message: InboundRecord) => boolean,
  change: (message: InboundRecord) => InboundRecord,
): number {
  const matches = [...records.messages.values()].filter(match);
  records.transaction(() => matches.forEach((message) => records.messages.set(message.id, change(message))));
  return matches.length;
}

function taskRecord(message: InboundRecord): TaskRecord {
  return parseTaskRecord({
    id: message.id,
    seriesId: seriesId(message),
    status: message.status as TaskRecord['status'],
    processAfter: message.processAfter,
    recurrence: message.recurrence,
    content: message.content,
    timestamp: message.timestamp,
    tries: message.tries,
    sequence: sequence(message),
  });
}

function compareTaskCandidates(a: InboundRecord, b: InboundRecord, now: number): number {
  const rank = (message: InboundRecord): number => {
    if (message.status === 'paused' || (message.status === 'pending' && future(message.processAfter, now))) return 0;
    if (message.status === 'pending') return 1;
    return 2;
  };
  const ranked = rank(a) - rank(b);
  if (ranked !== 0) return ranked;
  return liveTask(a) && liveTask(b) ? sequence(a) - sequence(b) : sequence(b) - sequence(a);
}

export function createInboundMailbox(records: InboundData, allocateSequence: () => Promise<number>): InboundMailbox {
  const insertTask = async (task: Task): Promise<void> => {
    const record = createTaskInboundRecord(task, await allocateSequence(), new Date().toISOString());
    insert(records.messages, record.id, record);
  };

  return {
    setRouting: (routing) => records.routing.set('routing', routing),
    replaceDestinations: (entries) =>
      records.transaction(() => {
        records.destinations.clear();
        for (const entry of entries) insert(records.destinations, entry.name, entry);
      }),
    insertMessage: async (message: InboundMessage) => {
      const record = createInboundRecord(message, await allocateSequence());
      insert(records.messages, record.id, record);
    },
    countDueMessages: () =>
      [...records.messages.values()].filter(
        (message) => message.status === 'pending' && message.trigger && due(message.processAfter),
      ).length,
    markMessageFailed: (messageId) => {
      const message = records.messages.get(messageId);
      if (message) records.messages.set(messageId, { ...message, status: 'failed' });
    },
    retryWithBackoff: (messageId, backoffSec) => {
      const message = records.messages.get(messageId);
      if (message)
        records.messages.set(messageId, {
          ...message,
          tries: message.tries + 1,
          processAfter: parseIsoTimestamp(new Date(Date.now() + backoffSec * 1000).toISOString()),
        });
    },
    getMessageForRetry: (messageId, status) => {
      const message = records.messages.get(messageId);
      return message?.status === status
        ? {
            id: message.id,
            tries: message.tries,
            processAfter: message.processAfter,
          }
        : undefined;
    },
    applyProcessingAcks: (acks) =>
      records.transaction(() => {
        for (const ack of acks) {
          const message = records.messages.get(ack.messageId);
          if (!message || message.status === 'completed' || message.status === 'failed') continue;
          records.messages.set(message.id, {
            ...message,
            status: ack.status === 'script-skip:error' ? 'failed' : 'completed',
          });
        }
      }),
    getDeliveredIds: () => new Set(records.deliveries.keys()),
    markDelivered: (messageOutId, platformMessageId) => {
      if (!records.deliveries.has(messageOutId))
        records.deliveries.set(messageOutId, {
          messageOutId,
          platformMessageId,
          status: 'delivered',
          deliveredAt: parseIsoTimestamp(new Date().toISOString()),
        });
    },
    markDeliveryFailed: (messageOutId) => {
      if (!records.deliveries.has(messageOutId))
        records.deliveries.set(messageOutId, {
          messageOutId,
          platformMessageId: null,
          status: 'failed',
          deliveredAt: parseIsoTimestamp(new Date().toISOString()),
        });
    },
    getInboundSourceSessionId: (messageId) => records.messages.get(messageId)?.sourceSessionId ?? null,
    getMostRecentPeerSourceSessionId: (peerAgentGroupId) =>
      [...records.messages.values()]
        .filter(
          (message) =>
            message.channelType === 'agent' && message.platformId === peerAgentGroupId && message.sourceSessionId,
        )
        .sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0))[0]?.sourceSessionId ?? null,
    insertTask,
    /**
     * The recurring series' re-arm, as ONE durable step — the S3 sibling of the
     * SQLite driver's `armNextTask`.
     *
     * Both halves must land together or neither may. Insert the next occurrence
     * while the original still carries its recurrence and the series re-clones
     * itself on the following tick (duplicate runs, forever); clear the
     * recurrence first and a crash before the insert kills the series silently.
     * Neither failure announces itself, which is why the contract is atomic
     * rather than two calls a caller is trusted to order.
     *
     * The sequence is allocated BEFORE the transaction opens because allocation
     * is async and the transaction body is not — the same split `insertTask`
     * above already makes.
     */
    armNextTask: async (originalId, task) => {
      const record = createTaskInboundRecord(task, await allocateSequence(), new Date().toISOString());
      records.transaction(() => {
        insert(records.messages, record.id, record);
        const original = records.messages.get(originalId);
        if (original) records.messages.set(originalId, { ...original, recurrence: null });
      });
    },
    cancelTask: (taskId) =>
      changeTasks(
        records,
        (message) => liveTask(message, taskId),
        (message) => ({
          ...message,
          status: 'cancelled',
          recurrence: null,
        }),
      ),
    pauseTask: (taskId) =>
      changeTasks(
        records,
        (message) => liveTask(message, taskId) && message.status === 'pending',
        (message) => ({ ...message, status: 'paused' }),
      ),
    resumeTask: (taskId) =>
      changeTasks(
        records,
        (message) => liveTask(message, taskId) && message.status === 'paused',
        (message) => ({ ...message, status: 'pending' }),
      ),
    deleteTask: (taskId) => {
      const matches = [...records.messages.values()].filter(
        (message) => message.kind === 'task' && (message.id === taskId || message.seriesId === taskId),
      );
      records.transaction(() => matches.forEach(({ id }) => records.messages.delete(id)));
      return matches.length;
    },
    updateTask: (taskId, update: TaskUpdate) => {
      const now = Date.now();
      return changeTasks(
        records,
        (message) =>
          liveTask(message, taskId) &&
          (message.status === 'paused' || (message.status === 'pending' && future(message.processAfter, now))),
        (message) => {
          const content = JSON.parse(message.content) as Record<string, unknown>;
          if (update.prompt !== undefined) content.prompt = update.prompt;
          if (update.script !== undefined) content.script = update.script;
          return {
            ...message,
            content: JSON.stringify(content),
            processAfter:
              update.processAfter === undefined ? message.processAfter : parseIsoTimestamp(update.processAfter),
            recurrence: update.recurrence === undefined ? message.recurrence : update.recurrence,
          };
        },
      );
    },
    listLiveTasks: (status) => {
      const now = Date.now();
      const selected = new Map<string, InboundRecord>();
      for (const message of records.messages.values()) {
        if (!liveTask(message) || (status && message.status !== status)) continue;
        const key = seriesId(message);
        const current = selected.get(key);
        if (!current || compareTaskCandidates(message, current, now) < 0) selected.set(key, message);
      }
      return [...selected.values()]
        .sort((a, b) => (a.processAfter ?? '').localeCompare(b.processAfter ?? '') || sequence(a) - sequence(b))
        .map(taskRecord);
    },
    getTask: (taskId) => {
      const now = Date.now();
      const message = [...records.messages.values()]
        .filter((row) => row.kind === 'task' && (row.id === taskId || row.seriesId === taskId))
        .sort((a, b) => compareTaskCandidates(a, b, now))[0];
      return message ? taskRecord(message) : undefined;
    },
    getTaskStats: (seriesId): TaskStats => {
      const tasks = [...records.messages.values()].filter(
        (message) => message.kind === 'task' && (message.id === seriesId || message.seriesId === seriesId),
      );
      const completed = tasks.filter(({ status }) => status === 'completed');
      return {
        runs: completed.length,
        lastRun:
          completed
            .map(({ processAfter }) => processAfter)
            .filter((value) => value !== null)
            .sort()
            .at(-1) ?? null,
        failedRuns: tasks.filter(({ status }) => status === 'failed').length,
      };
    },
    getCompletedRecurring: () =>
      [...records.messages.values()]
        .filter(
          (message): message is InboundRecord & { recurrence: string } =>
            (message.status === 'completed' || message.status === 'failed') && message.recurrence !== null,
        )
        .map(({ id, content, recurrence, seriesId }) => ({
          id,
          content,
          recurrence,
          seriesId: seriesId ?? id,
        })),
    trailingFailedRuns: (seriesId) => {
      const tasks = [...records.messages.values()]
        .filter(
          (message) =>
            message.kind === 'task' &&
            (message.id === seriesId || message.seriesId === seriesId) &&
            (message.status === 'completed' || message.status === 'failed'),
        )
        .sort((a, b) => sequence(b) - sequence(a));
      const firstSuccess = tasks.findIndex(({ status }) => status !== 'failed');
      return firstSuccess === -1 ? tasks.length : firstSuccess;
    },
    clearRecurrence: (messageId) => {
      const message = records.messages.get(messageId);
      if (message) records.messages.set(messageId, { ...message, recurrence: null });
    },
    countLiveTasks: () => [...records.messages.values()].filter((message) => liveTask(message)).length,
    prunePendingMessages: (channelType, before, keep) => {
      const expired = [...records.messages.values()].filter(
        (message) =>
          message.channelType === channelType && message.status === 'pending' && message.timestamp < before,
      );
      const remaining = [...records.messages.values()]
        .filter((message) => message.channelType === channelType && message.status === 'pending')
        .sort((a, b) => sequence(b) - sequence(a));
      const overflow = remaining.slice(keep);
      const remove = new Set([...expired, ...overflow].map(({ id }) => id));
      records.transaction(() => remove.forEach((id) => records.messages.delete(id)));
      return remove.size;
    },
    getInboundHistory: (limit) =>
      [...records.messages.values()]
        .sort((a, b) => sequence(b) - sequence(a))
        .slice(0, limit)
        .map(({ timestamp, kind, content }): MailboxHistoryMessage => ({ timestamp, kind, content })),
    getConversationRoot: () => {
      const message = [...records.messages.values()]
        .filter(
          (row) =>
            (row.kind === 'chat' || row.kind === 'chat-sdk') &&
            row.trigger &&
            row.channelType !== 'session-echo' &&
            row.channelType !== 'agent',
        )
        .sort((a, b) => sequence(a) - sequence(b))[0];
      return message
        ? ({ timestamp: message.timestamp, content: message.content } satisfies MailboxTimelineMessage)
        : undefined;
    },
    findTaskBySeriesSlug: (slug) => {
      const prefix = `${slug}-`;
      const message = [...records.messages.values()]
        .filter(
          (row) =>
            row.kind === 'task' &&
            row.seriesId?.startsWith(prefix) &&
            /^[0-9a-f]{4}$/.test(row.seriesId.slice(prefix.length)),
        )
        .sort((a, b) => Number(liveTask(b)) - Number(liveTask(a)) || sequence(b) - sequence(a))[0];
      return message ? taskRecord(message) : undefined;
    },
  };
}

export function createOutboundMailbox(
  records: OutboundData,
  writeDirect: (message: DirectOutboundMessage) => Promise<void>,
): OutboundMailbox {
  return {
    getTerminalProcessingAcks: () =>
      [...records.acknowledgements.values()].filter(
        ({ status }) => status === 'completed' || status === 'failed' || status === 'script-skip:error',
      ),
    getProcessingClaims: () =>
      [...records.acknowledgements.values()]
        .filter(({ status }) => status === 'processing')
        .map(({ messageId, statusChanged }) => ({ messageId, statusChanged })),
    deleteOrphanProcessingClaims: () => {
      let deleted = 0;
      records.transaction(() => {
        for (const ack of records.acknowledgements.values()) {
          if (ack.status === 'processing' && records.acknowledgements.delete(ack.messageId)) deleted++;
        }
      });
      return deleted;
    },
    getContainerState: () => {
      const state = records.container.get('container');
      return state
        ? {
            currentTool: state.currentTool,
            toolDeclaredTimeoutMs: state.toolDeclaredTimeoutMs,
            toolStartedAt: state.toolStartedAt,
          }
        : null;
    },
    getDueMessages: (excludeIds) =>
      [...records.messages.values()]
        .filter((message) => due(message.deliverAfter) && !excludeIds?.has(message.id))
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
        .map(outboundDelivery),
    writeDirect,
    getOutboundHistory: (limit) =>
      [...records.messages.values()]
        .sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0))
        .slice(0, limit)
        .map(({ timestamp, kind, content }): MailboxHistoryMessage => ({ timestamp, kind, content })),
    getTopLevelOutbound: (limit) =>
      [...records.messages.values()]
        .filter(
          (message) =>
            message.kind !== 'system' &&
            message.kind !== 'task_log' &&
            message.channelType !== 'agent' &&
            (message.threadId === null || message.threadId === '' || message.threadId.endsWith(':')),
        )
        .sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0))
        .slice(0, limit)
        .map(({ timestamp, content }): MailboxTimelineMessage => ({ timestamp, content })),
  };
}
