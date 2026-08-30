/** Thin fail-open emit wrappers over the canonical privacy-safe activity mappers. */
import {
  mapAgentHandoff,
  mapDevEnvironmentBound,
  mapMessageReceived,
  mapSessionStarted,
  mapScheduleCreated,
  mapSkillCreated,
  mapTaskCreated,
  mapTaskRun,
  type AgentHandoffActivity,
  type DevEnvironmentBoundActivity,
  type MessageReceivedActivity,
  type TaskRunActivity,
} from './activity-mappers.js';
import { emitAuditEvent } from './emit.js';
import { isSkillName, structuralId } from './structural-validation.js';
import type { AuditActor, AuditEventInput, HostActivityClass } from './types.js';

async function emit(input: AuditEventInput | null): Promise<void> {
  if (input) await emitAuditEvent(input);
}

export interface InboundAuditActivity extends MessageReceivedActivity {
  created: boolean;
  sessionMode: string;
}

/** One awaited router boundary covers both the message and its newly-created session. */
export async function emitInboundAuditEvidence(activity: InboundAuditActivity): Promise<void> {
  await emit(mapMessageReceived(activity));
  if (activity.created) {
    await emit(mapSessionStarted({
      agentId: activity.agentId,
      sessionId: activity.sessionId,
      channelType: activity.channelType,
      messagingGroupId: activity.messagingGroupId,
      activityId: activity.activityId,
      sessionMode: activity.sessionMode,
    }));
  }
}

/** Called only at the successful end of the authoritative agent-route seam. */
export async function emitAgentHandoff(activity: AgentHandoffActivity): Promise<void> {
  await emit(mapAgentHandoff(activity));
}

/** Called only after the terminal occurrence status is durably applied. */
export async function emitTaskRun(activity: TaskRunActivity): Promise<void> {
  await emit(mapTaskRun(activity));
}

/**
 * Correlation fact for Governance enrichment. The Gateway remains unaware of
 * development modes: its unchanged session id joins this trusted Host event.
 */
export async function emitDevEnvironmentBound(activity: DevEnvironmentBoundActivity): Promise<void> {
  await emit(mapDevEnvironmentBound(activity));
}

export interface CliSemanticActivity {
  command: string;
  args: Record<string, unknown>;
  responseData: unknown;
  actor: AuditActor;
  agentId: string | null;
  sessionId: string | null;
  transport: 'socket' | 'container';
}

/** Map successful structural ncl results through the same canonical mappers as the golden. */
export async function emitSuccessfulCliSemantics(activity: CliSemanticActivity): Promise<void> {
  const data =
    typeof activity.responseData === 'object' && activity.responseData !== null
      ? (activity.responseData as Record<string, unknown>)
      : {};

  if (activity.command === 'tasks-create') {
    const seriesId = structuralId(data.series_id);
    if (!seriesId) return;
    const targetAgentId = structuralId(data.agent_group_id) ?? activity.agentId;
    const taskSessionId = structuralId(data.session_id) ?? activity.sessionId;
    const mapped = {
      actor: activity.actor,
      agentId: targetAgentId,
      sessionId: taskSessionId,
      seriesId,
      transport: activity.transport,
      recurring: typeof data.recurrence === 'string' && data.recurrence.length > 0,
    };
    await emit(mapTaskCreated(mapped));
    await emit(mapScheduleCreated(mapped));
    return;
  }

  if (activity.command === 'skills-add') {
    const skillName = structuralId(data.added);
    const targetAgentId = structuralId(activity.args.group ?? activity.args.id) ?? activity.agentId;
    if (!skillName || !targetAgentId) return;
    await emit(mapSkillCreated({
      actor: activity.actor,
      agentId: targetAgentId,
      sessionId: activity.sessionId,
      skillName,
      transport: activity.transport,
    }));
  }
}

export interface ContainerSkillActivity {
  eventType: Extract<HostActivityClass, 'skill_created' | 'skill_used'>;
  activityId: string;
}

export function parseContainerSkillActivity(value: unknown): ContainerSkillActivity | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join(',') !== 'action,activity_id,event_type' ||
    row.action !== 'host_audit_activity' ||
    (row.event_type !== 'skill_created' && row.event_type !== 'skill_used') ||
    !isSkillName(row.activity_id)
  ) {
    return null;
  }
  return { eventType: row.event_type, activityId: row.activity_id };
}
