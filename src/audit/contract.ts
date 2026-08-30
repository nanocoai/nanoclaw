/** Closed producer-side builder and wire serializer for nanoco.host-audit.v1. */
import {
  HOST_AUDIT_ACTION_RE,
  HOST_AUDIT_ARG_NAME_RE,
  HOST_AUDIT_ERROR_CODES,
  HOST_AUDIT_HUMAN_PSEUDONYM_RE,
  HOST_AUDIT_USER_PSEUDONYM_REF_RE,
  HOST_AUDIT_OPAQUE_ID_RE,
  HOST_AUDIT_SCHEDULE_MODES,
  HOST_AUDIT_SCHEMA_VERSION,
  HOST_AUDIT_TOKEN_RE,
  HOST_ACTIVITY_CLASSES,
  isHostAuditResourceRef,
  type AuditEvent,
  type AuditEventInput,
  type HostActivityClass,
  type HostAuditBatchV1,
  type HostAuditDimensions,
} from './types.js';

const ID_MAX = 256;
const ACTION_MAX = 128;
const VALUE_MAX = 64;
const MAX_DIMENSIONS_BYTES = 16 * 1024;
export const HOST_AUDIT_MAX_BATCH_ITEMS = 512;
export const HOST_AUDIT_MAX_BATCH_BYTES = 1024 * 1024;
const HOST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID_KEYS = new Set([
  'messaging_group_id',
  'activity_id',
  'target_agent_id',
  'source_session_id',
  'correlation_id',
  'environment_id',
  'instance_namespace',
]);
const ACTION_KEYS = new Set(['action']);
const TOKEN_KEYS = new Set(['channel_type', 'session_mode']);
const ARRAY_LIMITS: Record<string, { count: number; item: number }> = {
  arg_names: { count: 32, item: 64 },
  resource_refs: { count: 16, item: 256 },
};
const DIMENSION_KEYS = new Set([
  'transport', 'channel_type', 'messaging_group_id', 'activity_id', 'target_agent_id', 'source_session_id',
  'session_kind', 'file_count', 'file_direction', 'file_classification', 'action', 'outcome', 'resource_refs',
  'correlation_id', 'arg_names', 'mode', 'session_mode', 'error_code',
  'environment_id', 'instance_namespace',
]);
const INTRINSIC_VALUES: Record<string, ReadonlySet<string>> = {
  transport: new Set(['socket', 'container', 'channel']),
  session_kind: new Set(['interactive', 'scheduled']),
  file_direction: new Set(['inbound', 'outbound']),
  file_classification: new Set(['text_only', 'contains_non_text', 'unknown']),
  outcome: new Set(['success', 'failure', 'denied', 'pending', 'approved']),
  error_code: new Set(HOST_AUDIT_ERROR_CODES),
  mode: new Set(HOST_AUDIT_SCHEDULE_MODES),
};

interface EventProfile {
  required: readonly string[];
  allowed: ReadonlySet<string>;
  actorRequired: boolean;
  agentRequired: boolean;
  sessionRequired: boolean;
}

function profile(
  required: readonly string[],
  optional: readonly string[],
  identity: Pick<EventProfile, 'actorRequired' | 'agentRequired' | 'sessionRequired'>,
): EventProfile {
  return { required, allowed: new Set([...required, ...optional]), ...identity };
}

const EVENT_PROFILES: Record<HostActivityClass, EventProfile> = {
  message_received: profile(
    ['transport', 'channel_type', 'messaging_group_id', 'activity_id'],
    [],
    { actorRequired: false, agentRequired: true, sessionRequired: true },
  ),
  response_completed: profile(
    ['transport', 'activity_id', 'outcome'],
    ['channel_type', 'messaging_group_id'],
    { actorRequired: true, agentRequired: true, sessionRequired: true },
  ),
  session_started: profile(
    ['transport', 'channel_type', 'messaging_group_id', 'activity_id', 'session_kind', 'session_mode'],
    [],
    { actorRequired: true, agentRequired: true, sessionRequired: true },
  ),
  task_created: profile(
    ['transport', 'activity_id', 'resource_refs'],
    [],
    { actorRequired: true, agentRequired: false, sessionRequired: false },
  ),
  task_run: profile(
    ['transport', 'session_kind', 'activity_id', 'resource_refs', 'outcome'],
    [],
    { actorRequired: true, agentRequired: true, sessionRequired: true },
  ),
  skill_created: profile(
    ['transport', 'activity_id', 'resource_refs'],
    [],
    { actorRequired: true, agentRequired: true, sessionRequired: false },
  ),
  skill_used: profile(
    ['transport', 'activity_id', 'resource_refs'],
    [],
    { actorRequired: true, agentRequired: true, sessionRequired: true },
  ),
  file_delivered: profile(
    ['transport', 'activity_id', 'file_count', 'file_direction', 'file_classification', 'outcome'],
    ['channel_type', 'messaging_group_id'],
    { actorRequired: true, agentRequired: true, sessionRequired: true },
  ),
  schedule_created: profile(
    ['transport', 'activity_id', 'resource_refs', 'mode'],
    [],
    { actorRequired: true, agentRequired: false, sessionRequired: false },
  ),
  agent_handoff: profile(
    ['transport', 'target_agent_id', 'source_session_id', 'activity_id', 'outcome'],
    [],
    { actorRequired: true, agentRequired: true, sessionRequired: true },
  ),
  dev_environment_bound: profile(
    ['transport', 'environment_id', 'instance_namespace', 'resource_refs', 'outcome'],
    [],
    { actorRequired: true, agentRequired: true, sessionRequired: true },
  ),
  ncl_action: profile(
    ['transport', 'arg_names', 'action', 'outcome'],
    ['channel_type', 'messaging_group_id', 'resource_refs', 'correlation_id', 'error_code'],
    { actorRequired: true, agentRequired: false, sessionRequired: false },
  ),
};

export interface HostAuditEnvelopeFieldsV1 {
  hostId: string;
  seq: number;
  eventId: string;
  occurredAt: string;
}

function bounded(value: string, max: number, field: string): string {
  if (value.length < 1 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`invalid structural ${field}`);
  }
  return value;
}

function validateDimensions(dimensions: HostAuditDimensions): HostAuditDimensions {
  for (const [key, value] of Object.entries(dimensions)) {
    if (value === undefined) continue;
    if (!DIMENSION_KEYS.has(key)) throw new Error(`unknown audit dimension ${key}`);
    if (key === 'file_count') {
      if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000_000) {
        throw new Error('invalid structural file_count');
      }
      continue;
    }
    const arrayLimit = ARRAY_LIMITS[key];
    if (arrayLimit) {
      if (!Array.isArray(value) || value.length > arrayLimit.count || new Set(value).size !== value.length) {
        throw new Error(`invalid structural ${key}`);
      }
      for (const item of value) {
        if (typeof item !== 'string') throw new Error(`invalid structural ${key}`);
        bounded(item, arrayLimit.item, key);
        if (key === 'resource_refs' && !isHostAuditResourceRef(item)) {
          throw new Error('invalid structural resource_refs');
        }
        if (key === 'resource_refs' && item.startsWith('user:') && !HOST_AUDIT_USER_PSEUDONYM_REF_RE.test(item)) {
          throw new Error('invalid structural resource_refs');
        }
        if (key === 'arg_names' && !HOST_AUDIT_ARG_NAME_RE.test(item)) {
          throw new Error('invalid structural arg_names');
        }
      }
      continue;
    }
    if (typeof value !== 'string') throw new Error(`invalid structural ${key}`);
    bounded(value, ID_KEYS.has(key) ? ID_MAX : ACTION_KEYS.has(key) ? ACTION_MAX : VALUE_MAX, key);
    if (ID_KEYS.has(key) && !HOST_AUDIT_OPAQUE_ID_RE.test(value)) {
      throw new Error(`invalid structural ${key}`);
    }
    if (ACTION_KEYS.has(key) && !HOST_AUDIT_ACTION_RE.test(value)) {
      throw new Error(`invalid structural ${key}`);
    }
    if (TOKEN_KEYS.has(key) && !HOST_AUDIT_TOKEN_RE.test(value)) {
      throw new Error(`invalid structural ${key}`);
    }
    if (INTRINSIC_VALUES[key] && !INTRINSIC_VALUES[key].has(value)) throw new Error(`invalid structural ${key}`);
  }
  if (Buffer.byteLength(JSON.stringify(dimensions), 'utf8') > MAX_DIMENSIONS_BYTES) {
    throw new Error('audit dimensions exceed 16 KiB');
  }
  return dimensions;
}

function requireFixedDimension(
  eventType: HostActivityClass,
  dimensions: HostAuditDimensions,
  key: keyof HostAuditDimensions,
  accepted: readonly unknown[],
): void {
  if (!accepted.includes(dimensions[key])) throw new Error(`invalid ${eventType} dimension ${key}`);
}

function requireTypedResourceRef(
  eventType: HostActivityClass,
  dimensions: HostAuditDimensions,
  kind: 'task' | 'skill',
  matchActivity: boolean,
): void {
  const refs = dimensions.resource_refs;
  const expected = `${kind}:${dimensions.activity_id}`;
  if (
    !Array.isArray(refs) ||
    refs.length !== 1 ||
    typeof refs[0] !== 'string' ||
    (matchActivity ? refs[0] !== expected : !refs[0].startsWith(`${kind}:`) || refs[0].length === kind.length + 1)
  ) {
    throw new Error(`${eventType} requires one ${kind} resource ref`);
  }
}

function validateEventProfile(input: AuditEventInput, dimensions: HostAuditDimensions): void {
  const eventType = input.eventType;
  const eventProfile = EVENT_PROFILES[eventType];
  for (const key of eventProfile.required) {
    if (dimensions[key as keyof HostAuditDimensions] === undefined) {
      throw new Error(`missing audit dimension ${key}`);
    }
  }
  for (const [key, value] of Object.entries(dimensions)) {
    if (value !== undefined && !eventProfile.allowed.has(key)) {
      throw new Error(`audit dimension ${key} is not allowed on ${eventType}`);
    }
  }
  if (eventProfile.actorRequired && !input.actor) throw new Error(`${eventType} requires actor`);
  if (eventProfile.agentRequired && (input.agentId === null || input.agentId === undefined)) {
    throw new Error(`${eventType} requires agent_id`);
  }
  if (eventProfile.sessionRequired && (input.sessionId === null || input.sessionId === undefined)) {
    throw new Error(`${eventType} requires session_id`);
  }

  switch (eventType) {
    case 'message_received':
      requireFixedDimension(eventType, dimensions, 'transport', ['channel']);
      if (input.actor && input.actor.type !== 'human') {
        throw new Error('message_received actor must be human or null');
      }
      break;
    case 'response_completed':
      requireFixedDimension(eventType, dimensions, 'transport', ['channel']);
      requireFixedDimension(eventType, dimensions, 'outcome', ['success']);
      if (input.actor?.type !== 'agent' || input.actor.id !== input.agentId) {
        throw new Error('response_completed actor must equal agent_id');
      }
      break;
    case 'session_started':
      requireFixedDimension(eventType, dimensions, 'transport', ['channel']);
      requireFixedDimension(eventType, dimensions, 'session_kind', ['interactive']);
      if (input.actor?.type !== 'system' || input.actor.id !== 'nanoclaw-host') {
        throw new Error('session_started actor must be nanoclaw-host');
      }
      break;
    case 'task_created':
      requireFixedDimension(eventType, dimensions, 'transport', ['socket', 'container']);
      requireTypedResourceRef(eventType, dimensions, 'task', true);
      if (dimensions.transport === 'socket' && input.actor?.type !== 'human') {
        throw new Error('task_created socket transport requires human actor');
      }
      if (dimensions.transport === 'container' && input.actor?.type !== 'agent') {
        throw new Error('task_created container transport requires agent actor');
      }
      break;
    case 'task_run':
      requireFixedDimension(eventType, dimensions, 'transport', ['container']);
      requireFixedDimension(eventType, dimensions, 'session_kind', ['scheduled']);
      requireFixedDimension(eventType, dimensions, 'outcome', ['success', 'failure']);
      requireTypedResourceRef(eventType, dimensions, 'task', false);
      if (input.actor?.type !== 'system' || input.actor.id !== 'nanoclaw-host') {
        throw new Error('task_run actor must be nanoclaw-host');
      }
      break;
    case 'skill_created':
      requireFixedDimension(eventType, dimensions, 'transport', ['socket', 'container']);
      requireTypedResourceRef(eventType, dimensions, 'skill', true);
      if (dimensions.transport === 'socket' && input.actor?.type !== 'human') {
        throw new Error('skill_created socket transport requires human actor');
      }
      if (dimensions.transport === 'container' && input.actor?.type !== 'agent') {
        throw new Error('skill_created container transport requires agent actor');
      }
      break;
    case 'skill_used':
      requireFixedDimension(eventType, dimensions, 'transport', ['container']);
      requireTypedResourceRef(eventType, dimensions, 'skill', true);
      if (input.actor?.type !== 'agent' || input.actor.id !== input.agentId) {
        throw new Error('skill_used actor must equal agent_id');
      }
      break;
    case 'file_delivered':
      requireFixedDimension(eventType, dimensions, 'transport', ['channel']);
      requireFixedDimension(eventType, dimensions, 'file_direction', ['outbound']);
      requireFixedDimension(eventType, dimensions, 'outcome', ['success']);
      if (!Number.isSafeInteger(dimensions.file_count) || (dimensions.file_count as number) < 1) {
        throw new Error('file_delivered requires file_count >= 1 and file_classification');
      }
      if (input.actor?.type !== 'agent' || input.actor.id !== input.agentId) {
        throw new Error('file_delivered actor must equal agent_id');
      }
      break;
    case 'schedule_created':
      requireFixedDimension(eventType, dimensions, 'transport', ['socket', 'container']);
      requireFixedDimension(eventType, dimensions, 'mode', HOST_AUDIT_SCHEDULE_MODES);
      requireTypedResourceRef(eventType, dimensions, 'task', true);
      if (dimensions.transport === 'socket' && input.actor?.type !== 'human') {
        throw new Error('schedule_created socket transport requires human actor');
      }
      if (dimensions.transport === 'container' && input.actor?.type !== 'agent') {
        throw new Error('schedule_created container transport requires agent actor');
      }
      break;
    case 'agent_handoff':
      requireFixedDimension(eventType, dimensions, 'transport', ['container']);
      requireFixedDimension(eventType, dimensions, 'outcome', ['success']);
      if (input.actor?.type !== 'agent' || input.actor.id !== input.agentId) {
        throw new Error('agent_handoff actor must equal agent_id');
      }
      if (dimensions.source_session_id !== input.sessionId) {
        throw new Error('agent_handoff source_session_id must equal session_id');
      }
      break;
    case 'dev_environment_bound':
      requireFixedDimension(eventType, dimensions, 'transport', ['container']);
      requireFixedDimension(eventType, dimensions, 'outcome', ['success']);
      if (input.actor?.type !== 'agent' || input.actor.id !== input.agentId) {
        throw new Error('dev_environment_bound actor must equal agent_id');
      }
      if (dimensions.resource_refs?.length !== 1
        || dimensions.resource_refs[0] !== `dev_environment:${dimensions.environment_id}`) {
        throw new Error('dev_environment_bound requires its environment resource ref');
      }
      break;
    case 'ncl_action': {
      const transport = dimensions.transport;
      requireFixedDimension(eventType, dimensions, 'transport', ['socket', 'container']);
      if (dimensions.channel_type !== undefined && dimensions.messaging_group_id === undefined) {
        throw new Error('ncl_action channel_type requires messaging_group_id');
      }
      if (transport === 'socket' && (
        input.actor?.type !== 'human' || input.agentId !== null || input.sessionId !== null
      )) {
        throw new Error('socket ncl_action requires human actor and null agent/session');
      }
      if (transport === 'container' && (
        input.actor?.type !== 'agent' || input.agentId === null || input.agentId === undefined ||
        input.sessionId === null || input.sessionId === undefined
      )) {
        throw new Error('container ncl_action requires agent actor and agent/session');
      }
      if (transport === 'container' && input.actor?.id !== input.agentId) {
        throw new Error('container ncl_action actor must equal agent_id');
      }
      if (dimensions.outcome === 'failure') {
        if (!['exception', 'unknown-command', 'command-failed'].includes(dimensions.error_code ?? '')) {
          throw new Error('failed ncl_action requires a failure error_code');
        }
      } else if (dimensions.outcome === 'denied') {
        if (dimensions.error_code !== 'forbidden') {
          throw new Error('denied ncl_action requires forbidden error_code');
        }
      } else if (dimensions.error_code !== undefined) {
        throw new Error(`${dimensions.outcome} ncl_action must not include error_code`);
      }
      break;
    }
  }
}

export function buildHostAuditEventV1(input: AuditEventInput, fields: HostAuditEnvelopeFieldsV1): AuditEvent {
  if (!HOST_ID_RE.test(fields.hostId)) throw new Error('NANOCO_DEPLOYMENT_ID is not a valid host_id');
  if (!Number.isSafeInteger(fields.seq) || fields.seq < 1) throw new Error('invalid host audit seq');
  if (!UUID_RE.test(fields.eventId)) throw new Error('invalid host audit event_id');
  if (new Date(fields.occurredAt).toISOString() !== fields.occurredAt) {
    throw new Error('invalid host audit occurred_at');
  }
  if (!HOST_ACTIVITY_CLASSES.includes(input.eventType)) throw new Error('unknown host activity class');
  if (input.actor) {
    if (!['human', 'agent', 'system'].includes(input.actor.type)) throw new Error('invalid actor type');
    bounded(input.actor.id, ID_MAX, 'actor.id');
  }
  if (input.agentId !== null && input.agentId !== undefined) bounded(input.agentId, ID_MAX, 'agent_id');
  if (input.sessionId !== null && input.sessionId !== undefined) bounded(input.sessionId, ID_MAX, 'session_id');
  const dimensions = validateDimensions(input.dimensions ?? {});
  validateEventProfile(input, dimensions);
  if (input.actor?.type === 'human' && !HOST_AUDIT_HUMAN_PSEUDONYM_RE.test(input.actor.id)) {
    throw new Error('human actor must be a keyed Host audit pseudonym');
  }

  return {
    schema_version: HOST_AUDIT_SCHEMA_VERSION,
    event_id: fields.eventId,
    host_id: fields.hostId,
    seq: fields.seq,
    occurred_at: fields.occurredAt,
    event_type: input.eventType,
    provenance: 'host-observed',
    actor: input.actor,
    agent_id: input.agentId ?? null,
    session_id: input.sessionId ?? null,
    dimensions,
  };
}

/** Exact HTTPS request bytes used by the Governance drain and golden generator. */
export function encodeHostAuditBatchV1(events: readonly AuditEvent[]): Buffer {
  if (events.length < 1 || events.length > HOST_AUDIT_MAX_BATCH_ITEMS) {
    throw new Error('invalid host audit batch item count');
  }
  const hostId = events[0].host_id;
  let previous = events[0].seq - 1;
  for (const event of events) {
    if (event.schema_version !== HOST_AUDIT_SCHEMA_VERSION) throw new Error('invalid host audit event version');
    if (event.host_id !== hostId) throw new Error('mixed host audit batch identity');
    if (event.seq !== previous + 1) throw new Error('non-contiguous host audit batch');
    previous = event.seq;
  }
  const batch: HostAuditBatchV1 = {
    schema_version: HOST_AUDIT_SCHEMA_VERSION,
    host_id: hostId,
    items: events.map((event) => ({ event })),
  };
  const bytes = Buffer.from(JSON.stringify(batch), 'utf8');
  if (bytes.byteLength > HOST_AUDIT_MAX_BATCH_BYTES) throw new Error('host audit batch exceeds 1 MiB');
  return bytes;
}
