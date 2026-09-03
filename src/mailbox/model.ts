/**
 * Canonical semantic contract for every persisted agent-mailbox record.
 *
 * Edit `src/mailbox/model.ts` only, then run `pnpm mailbox-model:generate`. The runner
 * copy is checked in because the Node host and Bun container are packaged independently
 * and deliberately share no runtime module.
 */

declare const isoTimestampBrand: unique symbol;

/** Exact `Date.prototype.toISOString()` representation, validated at a parser boundary. */
export type IsoTimestamp = string & { readonly [isoTimestampBrand]: true };

export function parseIsoTimestamp(value: unknown): IsoTimestamp {
  if (typeof value !== 'string') throw new Error('invalid ISO-8601 UTC timestamp');
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value)
    throw new Error('invalid ISO-8601 UTC timestamp');
  return value as IsoTimestamp;
}

export type ProcessingStatus = 'processing' | 'completed' | 'failed' | 'script-skip:error';
export type TaskStatus = 'pending' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type InboundStatus = TaskStatus | 'processing';

const INBOUND_KINDS = ['chat', 'chat-sdk', 'task', 'webhook', 'system'] as const;

export type InboundKind = (typeof INBOUND_KINDS)[number];

export interface InboundWrite {
  id: string;
  kind: InboundKind;
  timestamp: string;
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  content: string;
  processAfter: string | null;
  recurrence: string | null;
  trigger?: boolean;
  sourceSessionId?: string | null;
  onWake?: boolean;
}

export interface InboundRecord {
  id: string;
  sequence: number | null;
  kind: InboundKind;
  timestamp: IsoTimestamp;
  status: InboundStatus;
  processAfter: IsoTimestamp | null;
  recurrence: string | null;
  seriesId: string | null;
  tries: number;
  trigger: boolean;
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  content: string;
  sourceSessionId: string | null;
  onWake: boolean;
}

export interface OutboundWrite {
  id: string;
  inReplyTo?: string | null;
  deliverAfter?: string | null;
  recurrence?: string | null;
  kind: string;
  platformId?: string | null;
  channelType?: string | null;
  threadId?: string | null;
  content: string;
}

export interface DirectOutboundWrite {
  id: string;
  kind: string;
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  content: string;
}

export interface OutboundRecord {
  id: string;
  sequence: number | null;
  inReplyTo: string | null;
  timestamp: IsoTimestamp;
  deliverAfter: IsoTimestamp | null;
  recurrence: string | null;
  kind: string;
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  content: string;
}

export interface OutboundDelivery {
  id: string;
  kind: string;
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  content: string;
  inReplyTo: string | null;
}

export interface ProcessingAckRecord {
  messageId: string;
  status: ProcessingStatus;
  statusChanged: IsoTimestamp;
}

export interface DeliveryRecord {
  messageOutId: string;
  platformMessageId: string | null;
  status: 'delivered' | 'failed';
  deliveredAt: IsoTimestamp;
}

interface DestinationRecordBase {
  name: string;
  displayName: string | null;
}

export type DestinationRecord =
  | (DestinationRecordBase & {
      type: 'channel';
      channelType: string;
      platformId: string;
      agentGroupId: null;
    })
  | (DestinationRecordBase & {
      type: 'agent';
      channelType: null;
      platformId: null;
      agentGroupId: string;
    });

export interface SessionRoutingRecord {
  channelType: string | null;
  platformId: string | null;
  threadId: string | null;
}

export interface StateRecord {
  key: string;
  value: string;
  updatedAt: IsoTimestamp;
}

export interface ContainerRecord {
  currentTool: string | null;
  toolDeclaredTimeoutMs: number | null;
  toolStartedAt: IsoTimestamp | null;
  updatedAt: IsoTimestamp;
}

export interface TaskWrite {
  id: string;
  seriesId: string;
  processAfter: string | null;
  recurrence: string | null;
  content: string;
  status?: 'pending' | 'paused';
}

export interface TaskRecord {
  id: string;
  seriesId: string | null;
  status: TaskStatus;
  processAfter: IsoTimestamp | null;
  recurrence: string | null;
  content: string;
  timestamp: IsoTimestamp;
  tries: number;
  sequence: number;
}

export type MailboxRecordKind =
  | 'inbound'
  | 'outbound'
  | 'processingAck'
  | 'delivery'
  | 'destination'
  | 'sessionRouting'
  | 'state'
  | 'container';

export interface MailboxRecordByKind {
  inbound: InboundRecord;
  outbound: OutboundRecord;
  processingAck: ProcessingAckRecord;
  delivery: DeliveryRecord;
  destination: DestinationRecord;
  sessionRouting: SessionRoutingRecord;
  state: StateRecord;
  container: ContainerRecord;
}

type UnknownRecord = Record<string, unknown>;

function strictRecord(value: unknown, name: string, keys: readonly string[]): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid ${name}: expected object`);
  const record = value as UnknownRecord;
  const unknown = Object.keys(record).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new Error(`invalid ${name}: unknown field ${unknown[0]}`);
  const nested = Object.entries(record).find(([, field]) => field !== null && typeof field === 'object');
  if (nested) throw new Error(`invalid ${name}: nested field ${nested[0]}`);
  return record;
}

function text(record: UnknownRecord, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`invalid mailbox field ${key}: expected string`);
  return value;
}

function nullableText(record: UnknownRecord, key: string): string | null {
  const value = record[key];
  if (value !== null && typeof value !== 'string')
    throw new Error(`invalid mailbox field ${key}: expected string or null`);
  return value;
}

function optionalNullableText(record: UnknownRecord, key: string): string | null | undefined {
  if (!(key in record)) return undefined;
  if (record[key] === undefined) return undefined;
  return nullableText(record, key);
}

function timestamp(record: UnknownRecord, key: string): IsoTimestamp {
  const value = text(record, key);
  try {
    return parseIsoTimestamp(value);
  } catch (err) {
    throw new Error(`invalid mailbox field ${key}: expected ISO-8601 UTC timestamp`, { cause: err });
  }
}

function nullableTimestamp(record: UnknownRecord, key: string): IsoTimestamp | null {
  if (record[key] === null) return null;
  return timestamp(record, key);
}

function optionalNullableTimestamp(record: UnknownRecord, key: string): IsoTimestamp | null | undefined {
  if (!(key in record) || record[key] === undefined) return undefined;
  return nullableTimestamp(record, key);
}

function nonNegativeInteger(record: UnknownRecord, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`invalid mailbox field ${key}: expected nonnegative integer`);
  return value as number;
}

function nullableNonNegativeInteger(record: UnknownRecord, key: string): number | null {
  const value = record[key];
  if (value !== null && (!Number.isSafeInteger(value) || (value as number) < 0))
    throw new Error(`invalid mailbox field ${key}: expected nonnegative integer or null`);
  return value as number | null;
}

function booleanValue(record: UnknownRecord, key: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') throw new Error(`invalid mailbox field ${key}: expected boolean`);
  return value;
}

function optionalBoolean(record: UnknownRecord, key: string): boolean | undefined {
  if (!(key in record)) return undefined;
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`invalid mailbox field ${key}: expected boolean`);
  return value;
}

function oneOf<const T extends readonly string[]>(record: UnknownRecord, key: string, values: T): T[number] {
  const value = record[key];
  if (typeof value !== 'string' || !values.includes(value))
    throw new Error(`invalid mailbox field ${key}: unexpected value`);
  return value as T[number];
}

export function parseInboundWrite(value: unknown): InboundWrite {
  const record = strictRecord(value, 'InboundWrite', [
    'id',
    'kind',
    'timestamp',
    'platformId',
    'channelType',
    'threadId',
    'content',
    'processAfter',
    'recurrence',
    'trigger',
    'sourceSessionId',
    'onWake',
  ]);
  return {
    id: text(record, 'id'),
    kind: oneOf(record, 'kind', INBOUND_KINDS),
    timestamp: timestamp(record, 'timestamp'),
    platformId: nullableText(record, 'platformId'),
    channelType: nullableText(record, 'channelType'),
    threadId: nullableText(record, 'threadId'),
    content: text(record, 'content'),
    processAfter: nullableTimestamp(record, 'processAfter'),
    recurrence: nullableText(record, 'recurrence'),
    ...('trigger' in record ? { trigger: optionalBoolean(record, 'trigger') } : {}),
    ...('sourceSessionId' in record ? { sourceSessionId: optionalNullableText(record, 'sourceSessionId') } : {}),
    ...('onWake' in record ? { onWake: optionalBoolean(record, 'onWake') } : {}),
  };
}

export function parseInboundRecord(value: unknown): InboundRecord {
  const record = strictRecord(value, 'InboundRecord', [
    'id',
    'sequence',
    'kind',
    'timestamp',
    'status',
    'processAfter',
    'recurrence',
    'seriesId',
    'tries',
    'trigger',
    'platformId',
    'channelType',
    'threadId',
    'content',
    'sourceSessionId',
    'onWake',
  ]);
  return {
    id: text(record, 'id'),
    sequence: nullableNonNegativeInteger(record, 'sequence'),
    kind: oneOf(record, 'kind', INBOUND_KINDS),
    timestamp: timestamp(record, 'timestamp'),
    status: oneOf(record, 'status', ['pending', 'paused', 'processing', 'completed', 'failed', 'cancelled'] as const),
    processAfter: nullableTimestamp(record, 'processAfter'),
    recurrence: nullableText(record, 'recurrence'),
    seriesId: nullableText(record, 'seriesId'),
    tries: nonNegativeInteger(record, 'tries'),
    trigger: booleanValue(record, 'trigger'),
    platformId: nullableText(record, 'platformId'),
    channelType: nullableText(record, 'channelType'),
    threadId: nullableText(record, 'threadId'),
    content: text(record, 'content'),
    sourceSessionId: nullableText(record, 'sourceSessionId'),
    onWake: booleanValue(record, 'onWake'),
  };
}

export function parseOutboundWrite(value: unknown): OutboundWrite {
  const record = strictRecord(value, 'OutboundWrite', [
    'id',
    'inReplyTo',
    'deliverAfter',
    'recurrence',
    'kind',
    'platformId',
    'channelType',
    'threadId',
    'content',
  ]);
  return {
    id: text(record, 'id'),
    ...('inReplyTo' in record ? { inReplyTo: optionalNullableText(record, 'inReplyTo') } : {}),
    ...('deliverAfter' in record ? { deliverAfter: optionalNullableTimestamp(record, 'deliverAfter') } : {}),
    ...('recurrence' in record ? { recurrence: optionalNullableText(record, 'recurrence') } : {}),
    kind: text(record, 'kind'),
    ...('platformId' in record ? { platformId: optionalNullableText(record, 'platformId') } : {}),
    ...('channelType' in record ? { channelType: optionalNullableText(record, 'channelType') } : {}),
    ...('threadId' in record ? { threadId: optionalNullableText(record, 'threadId') } : {}),
    content: text(record, 'content'),
  };
}

export function parseDirectOutboundWrite(value: unknown): DirectOutboundWrite {
  const record = strictRecord(value, 'DirectOutboundWrite', [
    'id',
    'kind',
    'platformId',
    'channelType',
    'threadId',
    'content',
  ]);
  return {
    id: text(record, 'id'),
    kind: text(record, 'kind'),
    platformId: nullableText(record, 'platformId'),
    channelType: nullableText(record, 'channelType'),
    threadId: nullableText(record, 'threadId'),
    content: text(record, 'content'),
  };
}

export function parseOutboundRecord(value: unknown): OutboundRecord {
  const record = strictRecord(value, 'OutboundRecord', [
    'id',
    'sequence',
    'inReplyTo',
    'timestamp',
    'deliverAfter',
    'recurrence',
    'kind',
    'platformId',
    'channelType',
    'threadId',
    'content',
  ]);
  return {
    id: text(record, 'id'),
    sequence: nullableNonNegativeInteger(record, 'sequence'),
    inReplyTo: nullableText(record, 'inReplyTo'),
    timestamp: timestamp(record, 'timestamp'),
    deliverAfter: nullableTimestamp(record, 'deliverAfter'),
    recurrence: nullableText(record, 'recurrence'),
    kind: text(record, 'kind'),
    platformId: nullableText(record, 'platformId'),
    channelType: nullableText(record, 'channelType'),
    threadId: nullableText(record, 'threadId'),
    content: text(record, 'content'),
  };
}

export function parseOutboundDelivery(value: unknown): OutboundDelivery {
  const record = strictRecord(value, 'OutboundDelivery', [
    'id',
    'kind',
    'platformId',
    'channelType',
    'threadId',
    'content',
    'inReplyTo',
  ]);
  return {
    id: text(record, 'id'),
    kind: text(record, 'kind'),
    platformId: nullableText(record, 'platformId'),
    channelType: nullableText(record, 'channelType'),
    threadId: nullableText(record, 'threadId'),
    content: text(record, 'content'),
    inReplyTo: nullableText(record, 'inReplyTo'),
  };
}

export function parseProcessingAckRecord(value: unknown): ProcessingAckRecord {
  const record = strictRecord(value, 'ProcessingAckRecord', ['messageId', 'status', 'statusChanged']);
  return {
    messageId: text(record, 'messageId'),
    status: oneOf(record, 'status', ['processing', 'completed', 'failed', 'script-skip:error'] as const),
    statusChanged: timestamp(record, 'statusChanged'),
  };
}

export function parseDeliveryRecord(value: unknown): DeliveryRecord {
  const record = strictRecord(value, 'DeliveryRecord', ['messageOutId', 'platformMessageId', 'status', 'deliveredAt']);
  return {
    messageOutId: text(record, 'messageOutId'),
    platformMessageId: nullableText(record, 'platformMessageId'),
    status: oneOf(record, 'status', ['delivered', 'failed'] as const),
    deliveredAt: timestamp(record, 'deliveredAt'),
  };
}

export function parseDestinationRecord(value: unknown): DestinationRecord {
  const record = strictRecord(value, 'DestinationRecord', [
    'name',
    'displayName',
    'type',
    'channelType',
    'platformId',
    'agentGroupId',
  ]);
  const common = {
    name: text(record, 'name'),
    displayName: nullableText(record, 'displayName'),
  };
  const type = oneOf(record, 'type', ['channel', 'agent'] as const);
  const channelType = nullableText(record, 'channelType');
  const platformId = nullableText(record, 'platformId');
  const agentGroupId = nullableText(record, 'agentGroupId');

  if (type === 'channel') {
    if (channelType === null || platformId === null || agentGroupId !== null)
      throw new Error('invalid DestinationRecord: channel routing fields');
    return { ...common, type, channelType, platformId, agentGroupId: null };
  }

  if (channelType !== null || platformId !== null || agentGroupId === null)
    throw new Error('invalid DestinationRecord: agent routing fields');
  return { ...common, type, channelType: null, platformId: null, agentGroupId };
}

export function parseSessionRoutingRecord(value: unknown): SessionRoutingRecord {
  const record = strictRecord(value, 'SessionRoutingRecord', ['channelType', 'platformId', 'threadId']);
  return {
    channelType: nullableText(record, 'channelType'),
    platformId: nullableText(record, 'platformId'),
    threadId: nullableText(record, 'threadId'),
  };
}

export function parseStateRecord(value: unknown): StateRecord {
  const record = strictRecord(value, 'StateRecord', ['key', 'value', 'updatedAt']);
  return { key: text(record, 'key'), value: text(record, 'value'), updatedAt: timestamp(record, 'updatedAt') };
}

export function parseContainerRecord(value: unknown): ContainerRecord {
  const record = strictRecord(value, 'ContainerRecord', [
    'currentTool',
    'toolDeclaredTimeoutMs',
    'toolStartedAt',
    'updatedAt',
  ]);
  return {
    currentTool: nullableText(record, 'currentTool'),
    toolDeclaredTimeoutMs: nullableNonNegativeInteger(record, 'toolDeclaredTimeoutMs'),
    toolStartedAt: nullableTimestamp(record, 'toolStartedAt'),
    updatedAt: timestamp(record, 'updatedAt'),
  };
}

export function parseTaskRecord(value: unknown): TaskRecord {
  const record = strictRecord(value, 'TaskRecord', [
    'id',
    'seriesId',
    'status',
    'processAfter',
    'recurrence',
    'content',
    'timestamp',
    'tries',
    'sequence',
  ]);
  return {
    id: text(record, 'id'),
    seriesId: nullableText(record, 'seriesId'),
    status: oneOf(record, 'status', ['pending', 'paused', 'completed', 'failed', 'cancelled'] as const),
    processAfter: nullableTimestamp(record, 'processAfter'),
    recurrence: nullableText(record, 'recurrence'),
    content: text(record, 'content'),
    timestamp: timestamp(record, 'timestamp'),
    tries: nonNegativeInteger(record, 'tries'),
    sequence: nonNegativeInteger(record, 'sequence'),
  };
}

export function parseTaskWrite(value: unknown): TaskWrite {
  const record = strictRecord(value, 'TaskWrite', [
    'id',
    'seriesId',
    'processAfter',
    'recurrence',
    'content',
    'status',
  ]);
  return {
    id: text(record, 'id'),
    seriesId: text(record, 'seriesId'),
    processAfter: nullableTimestamp(record, 'processAfter'),
    recurrence: nullableText(record, 'recurrence'),
    content: text(record, 'content'),
    ...('status' in record ? { status: oneOf(record, 'status', ['pending', 'paused'] as const) } : {}),
  };
}

export function createInboundRecord(message: InboundWrite, sequence: number): InboundRecord {
  const input = parseInboundWrite(message);
  return parseInboundRecord({
    ...input,
    sequence,
    status: 'pending',
    seriesId: input.id,
    tries: 0,
    trigger: input.trigger ?? true,
    sourceSessionId: input.sourceSessionId ?? null,
    onWake: input.onWake ?? false,
  });
}

export function createTaskInboundRecord(task: TaskWrite, sequence: number, timestamp: string): InboundRecord {
  const input = parseTaskWrite(task);
  return parseInboundRecord({
    id: input.id,
    sequence,
    kind: 'task',
    timestamp,
    status: input.status ?? 'pending',
    processAfter: input.processAfter,
    recurrence: input.recurrence,
    seriesId: input.seriesId,
    tries: 0,
    trigger: true,
    platformId: null,
    channelType: null,
    threadId: null,
    content: input.content,
    sourceSessionId: null,
    onWake: false,
  });
}

export function createOutboundRecord(message: OutboundWrite, sequence: number, timestamp: string): OutboundRecord {
  const input = parseOutboundWrite(message);
  return parseOutboundRecord({
    id: input.id,
    sequence,
    inReplyTo: input.inReplyTo ?? null,
    timestamp,
    deliverAfter: input.deliverAfter ?? null,
    recurrence: input.recurrence ?? null,
    kind: input.kind,
    platformId: input.platformId ?? null,
    channelType: input.channelType ?? null,
    threadId: input.threadId ?? null,
    content: input.content,
  });
}

export function createDirectOutboundRecord(
  message: DirectOutboundWrite,
  sequence: number,
  timestamp: string,
): OutboundRecord {
  return createOutboundRecord(parseDirectOutboundWrite(message), sequence, timestamp);
}

export function outboundDelivery(record: OutboundRecord): OutboundDelivery {
  const input = parseOutboundRecord(record);
  return parseOutboundDelivery({
    id: input.id,
    kind: input.kind,
    platformId: input.platformId,
    channelType: input.channelType,
    threadId: input.threadId,
    content: input.content,
    inReplyTo: input.inReplyTo,
  });
}

export function parseMailboxRecord<K extends MailboxRecordKind>(kind: K, value: unknown): MailboxRecordByKind[K] {
  switch (kind) {
    case 'inbound':
      return parseInboundRecord(value) as MailboxRecordByKind[K];
    case 'outbound':
      return parseOutboundRecord(value) as MailboxRecordByKind[K];
    case 'processingAck':
      return parseProcessingAckRecord(value) as MailboxRecordByKind[K];
    case 'delivery':
      return parseDeliveryRecord(value) as MailboxRecordByKind[K];
    case 'destination':
      return parseDestinationRecord(value) as MailboxRecordByKind[K];
    case 'sessionRouting':
      return parseSessionRoutingRecord(value) as MailboxRecordByKind[K];
    case 'state':
      return parseStateRecord(value) as MailboxRecordByKind[K];
    case 'container':
      return parseContainerRecord(value) as MailboxRecordByKind[K];
  }
}
