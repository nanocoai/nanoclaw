/** Versioned host activity contract shared with Governance. */

export const HOST_AUDIT_SCHEMA_VERSION = 'nanoco.host-audit.v1' as const;

export const HOST_ACTIVITY_CLASSES = [
  'message_received',
  'response_completed',
  'session_started',
  'task_created',
  'task_run',
  'skill_created',
  'skill_used',
  'file_delivered',
  'schedule_created',
  'agent_handoff',
  'dev_environment_bound',
  'ncl_action',
] as const;

/**
 * Complete structural resource vocabulary for nanoco.host-audit.v1.
 *
 * The ncl adapter maps every live CLI resource into this vocabulary. `skill`
 * is also emitted by the host activity mappers even though it is not an ncl
 * resource.
 */
export const HOST_AUDIT_RESOURCE_TYPES = [
  'agent_group',
  'approval',
  'audit_event',
  'destination',
  'dev_environment',
  'dropped_message',
  'member',
  'messaging_group',
  'policy',
  'role',
  'session',
  'skill',
  'task',
  'user',
  'user_dm',
  'wiring',
] as const;

export const HOST_AUDIT_RESOURCE_REF_MAX_LENGTH = 256;

/** Privacy-safe opaque identifiers used by structural dimension fields and resource refs. */
export const HOST_AUDIT_OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_:+-]*$/;
export const HOST_AUDIT_RESOURCE_IDENTIFIER_RE = HOST_AUDIT_OPAQUE_ID_RE;
export const HOST_AUDIT_ACTION_RE = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;
export const HOST_AUDIT_ARG_NAME_RE = /^[a-z0-9_]{1,64}$/;
export const HOST_AUDIT_TOKEN_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const HOST_AUDIT_HUMAN_PSEUDONYM_RE = /^hmac:[0-9a-f]{64}$/;
export const HOST_AUDIT_USER_PSEUDONYM_REF_RE = /^user:hmac:[0-9a-f]{64}$/;

export const HOST_AUDIT_SCHEDULE_MODES = ['recurring', 'one-shot'] as const;

export const HOST_AUDIT_ERROR_CODES = [
  'exception',
  'unknown-command',
  'forbidden',
  'command-failed',
] as const;

export type HostAuditResourceType = (typeof HOST_AUDIT_RESOURCE_TYPES)[number];
export type HostAuditResourceRef = HostAuditResourceType | `${HostAuditResourceType}:${string}`;
export type HostAuditErrorCode = (typeof HOST_AUDIT_ERROR_CODES)[number];
export type HostAuditScheduleMode = (typeof HOST_AUDIT_SCHEDULE_MODES)[number];

const HOST_AUDIT_RESOURCE_TYPE_SET: ReadonlySet<string> = new Set(HOST_AUDIT_RESOURCE_TYPES);

/** Bare closed type or `<type>:<non-empty ASCII structural identifier>`. */
export function isHostAuditResourceRef(value: unknown): value is HostAuditResourceRef {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > HOST_AUDIT_RESOURCE_REF_MAX_LENGTH
  ) return false;

  const separator = value.indexOf(':');
  const resourceType = separator === -1 ? value : value.slice(0, separator);
  if (!HOST_AUDIT_RESOURCE_TYPE_SET.has(resourceType)) return false;
  if (separator === -1) return true;
  return HOST_AUDIT_RESOURCE_IDENTIFIER_RE.test(value.slice(separator + 1));
}

/** Build a resource ref without ever admitting caller-controlled free text. */
export function hostAuditResourceRef(
  resourceType: HostAuditResourceType,
  identifier?: unknown,
): HostAuditResourceRef | null {
  if (identifier !== undefined && typeof identifier !== 'string') return null;
  const candidate = identifier === undefined ? resourceType : `${resourceType}:${identifier}`;
  return isHostAuditResourceRef(candidate) ? candidate : null;
}

export type HostActivityClass = (typeof HOST_ACTIVITY_CLASSES)[number];
export type AuditActorType = 'human' | 'agent' | 'system';
export type AuditOutcome = 'success' | 'failure' | 'denied' | 'pending' | 'approved';
export type FileClassification = 'text_only' | 'contains_non_text' | 'unknown';

export interface AuditActor {
  type: AuditActorType;
  /** Human IDs are per-installation keyed pseudonyms before this envelope is built. */
  id: string;
}

/** Closed structural dimensions accepted by Governance. */
export interface HostAuditDimensions {
  transport?: 'socket' | 'container' | 'channel';
  channel_type?: string;
  messaging_group_id?: string;
  activity_id?: string;
  target_agent_id?: string;
  source_session_id?: string;
  session_kind?: 'interactive' | 'scheduled';
  file_count?: number;
  file_direction?: 'inbound' | 'outbound';
  file_classification?: FileClassification;
  action?: string;
  outcome?: AuditOutcome;
  resource_refs?: HostAuditResourceRef[];
  correlation_id?: string;
  arg_names?: string[];
  mode?: HostAuditScheduleMode;
  session_mode?: string;
  error_code?: HostAuditErrorCode;
  environment_id?: string;
  instance_namespace?: string;
}

/** What emit sites provide. Durable envelope fields are stamped centrally. */
export interface AuditEventInput {
  eventType: HostActivityClass;
  actor: AuditActor | null;
  agentId?: string | null;
  sessionId?: string | null;
  dimensions?: HostAuditDimensions;
}

export interface AuditEvent {
  schema_version: typeof HOST_AUDIT_SCHEMA_VERSION;
  event_id: string;
  host_id: string;
  seq: number;
  occurred_at: string;
  event_type: HostActivityClass;
  provenance: 'host-observed';
  actor: AuditActor | null;
  agent_id: string | null;
  session_id: string | null;
  dimensions: HostAuditDimensions;
}

export interface HostAuditBatchV1 {
  schema_version: typeof HOST_AUDIT_SCHEMA_VERSION;
  host_id: string;
  items: Array<{ event: AuditEvent }>;
}

export interface HostAuditAcceptedV1 {
  schema_version: typeof HOST_AUDIT_SCHEMA_VERSION;
  status: 'accepted';
  host_id: string;
  acked_through_seq: number;
  accepted: number;
  duplicates: number;
}
