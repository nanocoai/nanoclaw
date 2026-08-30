import { describe, expect, it } from 'vitest';

import {
  classifyDeliveredFiles,
  mapAgentHandoff,
  mapFileDelivered,
  mapMessageReceived,
  mapNclAction,
  mapResponseCompleted,
  mapScheduleCreated,
  mapSessionStarted,
  mapSkillCreated,
  mapSkillUsed,
  mapTaskCreated,
  mapTaskRun,
} from './activity-mappers.js';
import { buildHostAuditEventV1 } from './contract.js';

describe('host activity mappers', () => {
  it('covers every required activity class through the shared pure mapper API', () => {
    const task = {
      actor: { type: 'agent' as const, id: 'agent-1' },
      agentId: 'agent-1',
      sessionId: 'session-task',
      seriesId: 'series-1',
      transport: 'container' as const,
      recurring: true,
    };
    const skill = {
      agentId: 'agent-1',
      sessionId: 'session-1',
      skillName: 'weekly-brief',
      transport: 'container' as const,
    };
    const events = [
      mapMessageReceived({
        actorId: 'user-1', agentId: 'agent-1', sessionId: 'session-1', channelType: 'slack',
        messagingGroupId: 'mg-1', activityId: 'message-1',
      }),
      mapResponseCompleted({ agentId: 'agent-1', sessionId: 'session-1', activityId: 'response-1' }),
      mapSessionStarted({
        agentId: 'agent-1', sessionId: 'session-1', activityId: 'message-1', sessionMode: 'per-thread',
      }),
      mapTaskCreated(task),
      mapTaskRun({
        agentId: 'agent-1', sessionId: 'session-task', seriesId: 'series-1', activityId: 'run-1', outcome: 'failure',
      }),
      mapSkillCreated(skill),
      mapSkillUsed(skill),
      mapFileDelivered({
        agentId: 'agent-1', sessionId: 'session-1', activityId: 'response-1', files: ['report.pdf'],
      }),
      mapScheduleCreated(task),
      mapAgentHandoff({
        sourceAgentId: 'agent-1', sourceSessionId: 'session-1', targetAgentId: 'agent-2', activityId: 'handoff-1',
      }),
      mapNclAction({
        actor: { type: 'human', id: 'host:test' }, agentId: null, sessionId: null,
        origin: { transport: 'socket' }, action: 'groups.list', outcome: 'success', argNames: ['format'],
        resourceRefs: ['agent_group'],
      }),
    ];

    expect(events.map((event) => event?.eventType)).toEqual([
      'message_received', 'response_completed', 'session_started', 'task_created', 'task_run', 'skill_created',
      'skill_used', 'file_delivered', 'schedule_created', 'agent_handoff', 'ncl_action',
    ]);
    expect(events[4]).toMatchObject({
      actor: { type: 'system', id: 'nanoclaw-host' },
      dimensions: { session_kind: 'scheduled', outcome: 'failure', resource_refs: ['task:series-1'] },
    });
  });

  it('classifies locally then discards all file source values with locked precedence', () => {
    expect(classifyDeliveredFiles(null)).toBeNull();
    expect(classifyDeliveredFiles('report.pdf')).toBeNull();
    expect(classifyDeliveredFiles([])).toBeNull();
    expect(classifyDeliveredFiles(['README.MD', '/private/source/data.json'])).toBe('text_only');
    expect(classifyDeliveredFiles(['README.md', 'report.pdf'])).toBe('contains_non_text');
    expect(classifyDeliveredFiles(['unknown.private', 'secret/report.PDF', 42])).toBe('contains_non_text');
    expect(classifyDeliveredFiles(['README', 'unknown.private', 42])).toBe('unknown');
    expect(classifyDeliveredFiles(['unknown.private'])).toBe('unknown');
    expect(classifyDeliveredFiles(['README'])).toBe('unknown');
    expect(classifyDeliveredFiles([42])).toBe('unknown');

    const event = mapFileDelivered({
      agentId: 'agent-1',
      sessionId: 'session-1',
      activityId: 'response-1',
      files: ['/vault/PRIVATE_SENTINEL.pdf', 'SECOND_SENTINEL.unknown'],
    });
    expect(event).toMatchObject({
      eventType: 'file_delivered',
      dimensions: { file_count: 2, file_classification: 'contains_non_text' },
    });
    expect(JSON.stringify(event)).not.toMatch(/PRIVATE_SENTINEL|SECOND_SENTINEL|\.pdf|\.unknown|\/vault/);
  });

  it('records the exact file count and rejects rather than clamps an impossible count', () => {
    const exact = mapFileDelivered({
      agentId: 'agent-1', sessionId: 'session-1', activityId: 'response-1', files: ['one.txt', 'two.txt'],
    });
    expect(exact?.dimensions?.file_count).toBe(2);
    expect(mapFileDelivered({
      agentId: 'agent-1', sessionId: 'session-1', activityId: 'response-1', files: new Array(1_000_001),
    })).toBeNull();
    expect(() => buildHostAuditEventV1({
      eventType: 'file_delivered',
      actor: { type: 'agent', id: 'agent-1' },
      agentId: 'agent-1',
      sessionId: 'session-1',
      dimensions: {
        file_count: 1_000_001,
        file_direction: 'outbound',
        file_classification: 'text_only',
      },
    }, {
      hostId: 'deployment-1',
      seq: 1,
      eventId: '10000000-0000-4000-8000-000000000001',
      occurredAt: '2026-08-23T10:00:00.000Z',
    })).toThrow('invalid structural file_count');
  });

  it('never maps caller-controlled CLI values into evidence', () => {
    const event = mapNclAction({
      actor: { type: 'human', id: 'host:test' },
      agentId: null,
      sessionId: null,
      origin: { transport: 'socket' },
      action: 'groups.update',
      outcome: 'success',
      argNames: ['model', 'role'],
      resourceRefs: ['agent_group:group-1'],
    });
    expect(JSON.stringify(event)).not.toMatch(/SECRET_MODEL_VALUE|SECRET_ROLE_VALUE/);
    expect(event?.dimensions).toEqual({
      transport: 'socket',
      arg_names: ['model', 'role'],
      action: 'groups.update',
      outcome: 'success',
      resource_refs: ['agent_group:group-1'],
    });
  });

  it('drops every invalid dimension carrier at the mapper seam', () => {
    const response = {
      agentId: 'agent-1', sessionId: 'session-1', channelType: 'slack',
      messagingGroupId: 'mg-1', activityId: 'response-1',
    };
    const task = {
      actor: { type: 'agent' as const, id: 'agent-1' }, agentId: 'agent-1',
      sessionId: 'session-1', seriesId: 'series-1', transport: 'container' as const,
      recurring: true,
    };

    expect(mapMessageReceived({
      actorId: 'email:alice@example.com', agentId: 'agent-1', sessionId: 'session-1',
      channelType: 'slack.com', messagingGroupId: 'mg-1', activityId: 'message-1',
    })).toBeNull();
    expect(mapMessageReceived({
      actorId: 'email:alice@example.com', agentId: 'agent-1', sessionId: 'session-1',
      channelType: 'slack', messagingGroupId: 'mg/private', activityId: 'message-1',
    })).toBeNull();
    expect(mapResponseCompleted({ ...response, activityId: 'quarterly-plan.docx' })).toBeNull();
    expect(mapSessionStarted({ ...response, sessionMode: 'per.thread' })).toBeNull();
    expect(mapTaskCreated({ ...task, seriesId: '/private/task' })).toBeNull();
    expect(mapScheduleCreated({ ...task, seriesId: 'quarterly-plan.docx' })).toBeNull();
    expect(mapTaskRun({
      agentId: 'agent-1', sessionId: 'session-1', seriesId: 'series-1',
      activityId: 'private run', outcome: 'success',
    })).toBeNull();
    expect(mapFileDelivered({ ...response, activityId: 'person@example.com', files: ['report.pdf'] })).toBeNull();
    expect(mapAgentHandoff({
      sourceAgentId: 'agent-1', sourceSessionId: 'session.private',
      targetAgentId: 'agent-2', activityId: 'handoff-1',
    })).toBeNull();
    expect(mapNclAction({
      actor: { type: 'human', id: 'email:alice@example.com' }, agentId: null, sessionId: null,
      origin: { transport: 'socket' }, action: '/private/groups.list', outcome: 'success',
      argNames: [], resourceRefs: [],
    })).toBeNull();
    expect(mapNclAction({
      actor: { type: 'human', id: 'email:alice@example.com' }, agentId: null, sessionId: null,
      origin: { transport: 'socket' }, action: 'groups.list', outcome: 'success',
      argNames: ['person@example.com'], resourceRefs: [],
    })).toBeNull();
    expect(mapNclAction({
      actor: { type: 'human', id: 'email:alice@example.com' }, agentId: null, sessionId: null,
      origin: { transport: 'socket' }, action: 'groups.list', outcome: 'success',
      argNames: [], resourceRefs: ['task:quarterly-plan.docx' as never],
    })).toBeNull();
    expect(mapNclAction({
      actor: { type: 'human', id: 'email:alice@example.com' }, agentId: null, sessionId: null,
      origin: { transport: 'socket' }, action: 'groups.list', outcome: 'success',
      argNames: [], resourceRefs: [], correlationId: 'approval.private',
    })).toBeNull();
  });

  it('retains namespaced top-level people while closing their dimensions', () => {
    const input = mapMessageReceived({
      actorId: 'email:alice@example.com', agentId: 'agent-1', sessionId: 'session-1',
      channelType: 'slack', messagingGroupId: 'mg-1', activityId: 'message-1',
    });
    expect(input?.actor).toEqual({ type: 'human', id: 'email:alice@example.com' });
    expect(input?.dimensions).toMatchObject({
      channel_type: 'slack', messaging_group_id: 'mg-1', activity_id: 'message-1',
    });
  });
});
