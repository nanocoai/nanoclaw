import { beforeEach, describe, expect, it, vi } from 'vitest';

const emitted = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('./emit.js', () => ({
  emitAuditEvent: (event: Record<string, unknown>) => emitted.push(event),
}));

import {
  emitAgentHandoff,
  emitDevEnvironmentBound,
  emitInboundAuditEvidence,
  emitSuccessfulCliSemantics,
  emitTaskRun,
  parseContainerSkillActivity,
} from './runtime-emitters.js';

beforeEach(() => emitted.splice(0));

describe('runtime activity mapping', () => {
  it('maps inbound, handoff, and completed task evidence without content fields', async () => {
    await emitInboundAuditEvidence({
      actorId: 'slack:u-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      channelType: 'slack',
      messagingGroupId: 'mg-1',
      activityId: 'message-1',
      created: true,
      sessionMode: 'per-thread',
    });
    await emitAgentHandoff({
      sourceAgentId: 'agent-1',
      sourceSessionId: 'session-1',
      targetAgentId: 'agent-2',
      activityId: 'handoff-1',
    });
    await emitTaskRun({
      agentId: 'agent-1', sessionId: 'task-session', seriesId: 'daily-1', activityId: 'run-1', outcome: 'success',
    });

    expect(emitted.map((event) => event.eventType)).toEqual([
      'message_received', 'session_started', 'agent_handoff', 'task_run',
    ]);
    expect(JSON.stringify(emitted)).not.toMatch(/content|text|path|arguments|prompt/);
    expect(emitted[2]).toMatchObject({
      dimensions: { target_agent_id: 'agent-2', source_session_id: 'session-1', outcome: 'success' },
    });
    expect(emitted[3]).toMatchObject({
      actor: { type: 'system', id: 'nanoclaw-host' },
      dimensions: { session_kind: 'scheduled', resource_refs: ['task:daily-1'], outcome: 'success' },
    });
  });

  it('emits task and schedule creation using only structural successful response fields', async () => {
    await emitSuccessfulCliSemantics({
      command: 'tasks-create',
      args: { recurrence: 'SECRET CRON', prompt: 'SECRET PROMPT' },
      responseData: {
        series_id: 'task-123',
        agent_group_id: 'target-agent',
        session_id: 'task-session',
        recurrence: 'SECRET CRON',
        ignored_body: 'SECRET RESPONSE',
      },
      actor: { type: 'agent', id: 'agent-1' },
      agentId: 'agent-1',
      sessionId: 'session-1',
      transport: 'container',
    });

    expect(emitted).toHaveLength(2);
    expect(emitted.map((event) => event.eventType)).toEqual(['task_created', 'schedule_created']);
    expect(emitted[0]).toMatchObject({ agentId: 'target-agent', sessionId: 'task-session' });
    expect(emitted[1]).toMatchObject({ dimensions: { mode: 'recurring', resource_refs: ['task:task-123'] } });
    expect(JSON.stringify(emitted)).not.toContain('SECRET');
  });

  it('emits skill creation only for a bounded structural skill name', async () => {
    const base = {
      command: 'skills-add',
      args: { files: 'SECRET SKILL BODY', group: 'target-agent' },
      actor: { type: 'human' as const, id: 'host:test' },
      agentId: null,
      sessionId: null,
      transport: 'socket' as const,
    };
    await emitSuccessfulCliSemantics({ ...base, responseData: { added: 'weekly-brief', files: 3 } });
    await emitSuccessfulCliSemantics({ ...base, responseData: { added: '../../escape' } });

    expect(emitted).toEqual([
      expect.objectContaining({
        eventType: 'skill_created',
        agentId: 'target-agent',
        dimensions: expect.objectContaining({ activity_id: 'weekly-brief', resource_refs: ['skill:weekly-brief'] }),
      }),
    ]);
    expect(JSON.stringify(emitted)).not.toContain('SECRET');
  });

  it('emits a trusted parent-agent to relay-session environment binding', async () => {
    await emitDevEnvironmentBound({
      parentAgentId: 'agent-1',
      relaySessionId: 'relay-session-1',
      environmentId: 'env-b8385d45-30f0-4573-863a-a0102d3843e8',
      instanceNamespace: 'nanoclaw-dev-b16c693e',
    });
    expect(emitted).toEqual([{
      eventType: 'dev_environment_bound',
      actor: { type: 'agent', id: 'agent-1' },
      agentId: 'agent-1',
      sessionId: 'relay-session-1',
      dimensions: {
        transport: 'container',
        environment_id: 'env-b8385d45-30f0-4573-863a-a0102d3843e8',
        instance_namespace: 'nanoclaw-dev-b16c693e',
        resource_refs: ['dev_environment:env-b8385d45-30f0-4573-863a-a0102d3843e8'],
        outcome: 'success',
      },
    }]);
  });
});

describe('container skill action contract', () => {
  it('parses only the complete closed structural action', () => {
    expect(parseContainerSkillActivity({
      action: 'host_audit_activity', event_type: 'skill_used', activity_id: 'weekly-brief',
    })).toEqual({ eventType: 'skill_used', activityId: 'weekly-brief' });
    expect(parseContainerSkillActivity({
      action: 'host_audit_activity', event_type: 'skill_used', activity_id: 'weekly-brief', path: '/secret',
    })).toBeNull();
    expect(parseContainerSkillActivity({
      action: 'host_audit_activity', event_type: 'skill_used', activity_id: '../escape',
    })).toBeNull();
    expect(parseContainerSkillActivity({
      action: 'other', event_type: 'skill_used', activity_id: 'weekly-brief',
    })).toBeNull();
  });
});
