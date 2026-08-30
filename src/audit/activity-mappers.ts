/** Pure, privacy-safe activity mappers shared by runtime emitters and goldens. */
import type {
  AuditActor,
  AuditEventInput,
  AuditOutcome,
  FileClassification,
  HostAuditErrorCode,
  HostAuditDimensions,
  HostAuditResourceRef,
} from './types.js';
import { hostAuditResourceRef, isHostAuditResourceRef } from './types.js';
import {
  isSkillName,
  structuralAction,
  structuralArgName,
  structuralId,
  structuralToken,
} from './structural-validation.js';

const TEXT_SUFFIXES = new Set([
  'txt', 'text', 'md', 'mdx', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'xml', 'html',
  'htm', 'css', 'scss', 'less', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java',
  'kt', 'kts', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'swift', 'sh', 'bash', 'zsh', 'fish', 'ps1',
  'sql', 'graphql', 'gql', 'toml', 'ini', 'cfg', 'conf', 'log', 'diff', 'patch',
]);
const NON_TEXT_SUFFIXES = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'epub', 'pages',
  'numbers', 'key', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'avif', 'svg',
  'ico', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'zip',
  'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar',
]);

function channelDimensions(activity: {
  channelType?: string | null;
  messagingGroupId?: string | null;
}): HostAuditDimensions | null {
  if (activity.channelType == null && activity.messagingGroupId == null) return { transport: 'channel' };
  const channelType = structuralToken(activity.channelType);
  const messagingGroupId = structuralId(activity.messagingGroupId);
  if (!channelType || !messagingGroupId) return null;
  return {
    transport: 'channel',
    channel_type: channelType,
    messaging_group_id: messagingGroupId,
  };
}

export interface MessageReceivedActivity {
  actorId: string | null;
  agentId: string;
  sessionId: string;
  channelType: string;
  messagingGroupId: string;
  activityId: string;
}

export function mapMessageReceived(activity: MessageReceivedActivity): AuditEventInput | null {
  const origin = channelDimensions(activity);
  const activityId = structuralId(activity.activityId);
  if (!origin || !activityId) return null;
  return {
    eventType: 'message_received',
    actor: activity.actorId ? { type: 'human', id: activity.actorId } : null,
    agentId: activity.agentId,
    sessionId: activity.sessionId,
    dimensions: {
      ...origin,
      activity_id: activityId,
    },
  };
}

export interface ResponseCompletedActivity {
  agentId: string;
  sessionId: string;
  channelType?: string | null;
  messagingGroupId?: string | null;
  activityId: string;
}

export function mapResponseCompleted(activity: ResponseCompletedActivity): AuditEventInput | null {
  const origin = channelDimensions(activity);
  const activityId = structuralId(activity.activityId);
  if (!origin || !activityId) return null;
  return {
    eventType: 'response_completed',
    actor: { type: 'agent', id: activity.agentId },
    agentId: activity.agentId,
    sessionId: activity.sessionId,
    dimensions: {
      ...origin,
      activity_id: activityId,
      outcome: 'success',
    },
  };
}

export interface SessionStartedActivity extends ResponseCompletedActivity {
  sessionMode: string;
}

export function mapSessionStarted(activity: SessionStartedActivity): AuditEventInput | null {
  const origin = channelDimensions(activity);
  const activityId = structuralId(activity.activityId);
  const sessionMode = structuralToken(activity.sessionMode);
  if (!origin || !activityId || !sessionMode) return null;
  return {
    eventType: 'session_started',
    actor: { type: 'system', id: 'nanoclaw-host' },
    agentId: activity.agentId,
    sessionId: activity.sessionId,
    dimensions: {
      ...origin,
      activity_id: activityId,
      session_kind: 'interactive',
      session_mode: sessionMode,
    },
  };
}

export interface TaskCreatedActivity {
  actor: AuditActor;
  agentId: string | null;
  sessionId: string | null;
  seriesId: string;
  transport: 'socket' | 'container';
  recurring: boolean;
}

export function mapTaskCreated(activity: TaskCreatedActivity): AuditEventInput | null {
  const seriesId = structuralId(activity.seriesId);
  const taskRef = seriesId ? hostAuditResourceRef('task', seriesId) : null;
  if (!seriesId || !taskRef) return null;
  return {
    eventType: 'task_created',
    actor: activity.actor,
    agentId: activity.agentId,
    sessionId: activity.sessionId,
    dimensions: {
      transport: activity.transport,
      activity_id: seriesId,
      resource_refs: [taskRef],
    },
  };
}

export function mapScheduleCreated(activity: TaskCreatedActivity): AuditEventInput | null {
  const task = mapTaskCreated(activity);
  if (!task) return null;
  return {
    ...task,
    eventType: 'schedule_created',
    dimensions: {
      ...task.dimensions,
      mode: activity.recurring ? 'recurring' : 'one-shot',
    },
  };
}

export interface TaskRunActivity {
  agentId: string;
  sessionId: string;
  seriesId: string;
  activityId: string;
  outcome: Extract<AuditOutcome, 'success' | 'failure'>;
}

export function mapTaskRun(activity: TaskRunActivity): AuditEventInput | null {
  const seriesId = structuralId(activity.seriesId);
  const activityId = structuralId(activity.activityId);
  const taskRef = seriesId ? hostAuditResourceRef('task', seriesId) : null;
  if (!seriesId || !activityId || !taskRef) return null;
  return {
    eventType: 'task_run',
    actor: { type: 'system', id: 'nanoclaw-host' },
    agentId: activity.agentId,
    sessionId: activity.sessionId,
    dimensions: {
      transport: 'container',
      session_kind: 'scheduled',
      activity_id: activityId,
      resource_refs: [taskRef],
      outcome: activity.outcome,
    },
  };
}

export interface SkillActivity {
  agentId: string;
  sessionId: string | null;
  skillName: string;
  actor?: AuditActor;
  transport: 'socket' | 'container';
}

function mapSkill(activity: SkillActivity, eventType: 'skill_created' | 'skill_used'): AuditEventInput | null {
  const skillName = structuralId(activity.skillName);
  if (!skillName || !isSkillName(skillName)) return null;
  return {
    eventType,
    actor: activity.actor ?? { type: 'agent', id: activity.agentId },
    agentId: activity.agentId,
    sessionId: activity.sessionId,
    dimensions: {
      transport: activity.transport,
      activity_id: skillName,
      resource_refs: [`skill:${skillName}`],
    },
  };
}

export function mapSkillCreated(activity: SkillActivity): AuditEventInput | null {
  return mapSkill(activity, 'skill_created');
}

export function mapSkillUsed(activity: SkillActivity): AuditEventInput | null {
  return mapSkill(activity, 'skill_used');
}

/** Inspect local file references, then discard them; only this enum is durable. */
export function classifyDeliveredFiles(files: unknown): FileClassification | null {
  if (!Array.isArray(files) || files.length === 0) return null;
  let unknown = false;
  for (const value of files) {
    if (typeof value !== 'string') {
      unknown = true;
      continue;
    }
    const leaf = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1);
    const dot = leaf.lastIndexOf('.');
    if (dot < 1 || dot === leaf.length - 1) {
      unknown = true;
      continue;
    }
    const suffix = leaf.slice(dot + 1).toLowerCase();
    if (NON_TEXT_SUFFIXES.has(suffix)) return 'contains_non_text';
    if (!TEXT_SUFFIXES.has(suffix)) unknown = true;
  }
  return unknown ? 'unknown' : 'text_only';
}

export interface FileDeliveredActivity extends ResponseCompletedActivity {
  files: unknown;
}

export function mapFileDelivered(activity: FileDeliveredActivity): AuditEventInput | null {
  if (!Array.isArray(activity.files) || activity.files.length > 1_000_000) return null;
  const origin = channelDimensions(activity);
  const activityId = structuralId(activity.activityId);
  const fileClassification = classifyDeliveredFiles(activity.files);
  if (!origin || !activityId || !fileClassification) return null;
  return {
    eventType: 'file_delivered',
    actor: { type: 'agent', id: activity.agentId },
    agentId: activity.agentId,
    sessionId: activity.sessionId,
    dimensions: {
      ...origin,
      activity_id: activityId,
      file_count: activity.files.length,
      file_direction: 'outbound',
      file_classification: fileClassification,
      outcome: 'success',
    },
  };
}

export interface AgentHandoffActivity {
  sourceAgentId: string;
  sourceSessionId: string;
  targetAgentId: string;
  activityId: string;
}

export function mapAgentHandoff(activity: AgentHandoffActivity): AuditEventInput | null {
  const targetAgentId = structuralId(activity.targetAgentId);
  const sourceSessionId = structuralId(activity.sourceSessionId);
  const activityId = structuralId(activity.activityId);
  if (!targetAgentId || !sourceSessionId || !activityId) return null;
  return {
    eventType: 'agent_handoff',
    actor: { type: 'agent', id: activity.sourceAgentId },
    agentId: activity.sourceAgentId,
    sessionId: activity.sourceSessionId,
    dimensions: {
      transport: 'container',
      target_agent_id: targetAgentId,
      source_session_id: sourceSessionId,
      activity_id: activityId,
      outcome: 'success',
    },
  };
}

export interface DevEnvironmentBoundActivity {
  parentAgentId: string;
  relaySessionId: string;
  environmentId: string;
  instanceNamespace: string;
}

export function mapDevEnvironmentBound(activity: DevEnvironmentBoundActivity): AuditEventInput | null {
  const agentId = structuralId(activity.parentAgentId);
  const sessionId = structuralId(activity.relaySessionId);
  const environmentId = structuralId(activity.environmentId);
  const instanceNamespace = structuralId(activity.instanceNamespace);
  const environmentRef = environmentId ? hostAuditResourceRef('dev_environment', environmentId) : null;
  if (!agentId || !sessionId || !environmentId || !instanceNamespace || !environmentRef) return null;
  return {
    eventType: 'dev_environment_bound',
    actor: { type: 'agent', id: agentId },
    agentId,
    sessionId,
    dimensions: {
      transport: 'container',
      environment_id: environmentId,
      instance_namespace: instanceNamespace,
      resource_refs: [environmentRef],
      outcome: 'success',
    },
  };
}

export interface NclActionActivity {
  actor: AuditActor;
  agentId: string | null;
  sessionId: string | null;
  origin: HostAuditDimensions;
  action: string;
  outcome: AuditOutcome;
  argNames: string[];
  resourceRefs: HostAuditResourceRef[];
  correlationId?: string | null;
  errorCode?: HostAuditErrorCode | null;
}

export function mapNclAction(activity: NclActionActivity): AuditEventInput | null {
  const originKeys = Object.keys(activity.origin).sort().join(',');
  const validOriginKeys = originKeys === 'transport'
    || originKeys === 'channel_type,messaging_group_id,transport';
  const channelType = activity.origin.channel_type === undefined
    ? null
    : structuralToken(activity.origin.channel_type);
  const messagingGroupId = activity.origin.messaging_group_id === undefined
    ? null
    : structuralId(activity.origin.messaging_group_id);
  const action = structuralAction(activity.action);
  const argNames = activity.argNames.map(structuralArgName);
  const correlationId = activity.correlationId == null ? null : structuralId(activity.correlationId);
  if (
    !validOriginKeys
    || (activity.origin.transport !== 'socket' && activity.origin.transport !== 'container')
    || (originKeys !== 'transport' && (!channelType || !messagingGroupId))
    || !action
    || activity.argNames.length > 32
    || argNames.some((name) => name === null)
    || activity.resourceRefs.length > 16
    || activity.resourceRefs.some((ref) => !isHostAuditResourceRef(ref))
    || (activity.correlationId != null && !correlationId)
  ) return null;
  return {
    eventType: 'ncl_action',
    actor: activity.actor,
    agentId: activity.agentId,
    sessionId: activity.sessionId,
    dimensions: {
      ...activity.origin,
      arg_names: argNames as string[],
      action,
      outcome: activity.outcome,
      ...(activity.resourceRefs.length > 0 ? { resource_refs: activity.resourceRefs } : {}),
      ...(correlationId ? { correlation_id: correlationId } : {}),
      ...(activity.errorCode ? { error_code: activity.errorCode } : {}),
    },
  };
}
