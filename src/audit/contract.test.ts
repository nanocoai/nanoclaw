import { describe, expect, it } from 'vitest';

import {
  mapAgentHandoff,
  mapDevEnvironmentBound,
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
import { pseudonymizeAuditInputWithKey } from './pseudonym.js';
import {
  HOST_AUDIT_ACTION_RE,
  HOST_AUDIT_ARG_NAME_RE,
  HOST_AUDIT_ERROR_CODES,
  HOST_AUDIT_HUMAN_PSEUDONYM_RE,
  HOST_AUDIT_OPAQUE_ID_RE,
  HOST_AUDIT_RESOURCE_IDENTIFIER_RE,
  HOST_AUDIT_RESOURCE_REF_MAX_LENGTH,
  HOST_AUDIT_RESOURCE_TYPES,
  HOST_AUDIT_SCHEDULE_MODES,
  HOST_AUDIT_TOKEN_RE,
  hostAuditResourceRef,
  isHostAuditResourceRef,
  type AuditEventInput,
  type HostActivityClass,
} from './types.js';

const fields = {
  hostId: 'deployment-1',
  seq: 1,
  eventId: '10000000-0000-4000-8000-000000000001',
  occurredAt: '2026-08-23T10:00:00.000Z',
};
const TEST_PSEUDONYM_KEY = Buffer.from('11'.repeat(32), 'hex');

function required(input: AuditEventInput | null): AuditEventInput {
  if (!input) throw new Error('mapper unexpectedly returned null');
  return input;
}

function validInputs(): Record<HostActivityClass, AuditEventInput> {
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
  const inputs: Record<HostActivityClass, AuditEventInput> = {
    message_received: required(mapMessageReceived({
      actorId: 'user-1', agentId: 'agent-1', sessionId: 'session-1', channelType: 'slack',
      messagingGroupId: 'mg-1', activityId: 'message-1',
    })),
    response_completed: required(mapResponseCompleted({
      agentId: 'agent-1', sessionId: 'session-1', activityId: 'response-1',
    })),
    session_started: required(mapSessionStarted({
      agentId: 'agent-1', sessionId: 'session-1', channelType: 'slack', messagingGroupId: 'mg-1',
      activityId: 'message-1', sessionMode: 'per-thread',
    })),
    task_created: required(mapTaskCreated(task)),
    task_run: required(mapTaskRun({
      agentId: 'agent-1', sessionId: 'session-task', seriesId: 'series-1', activityId: 'run-1', outcome: 'failure',
    })),
    skill_created: required(mapSkillCreated(skill)),
    skill_used: required(mapSkillUsed(skill)),
    file_delivered: required(mapFileDelivered({
      agentId: 'agent-1', sessionId: 'session-1', activityId: 'response-1', files: ['report.pdf'],
    })),
    schedule_created: required(mapScheduleCreated(task)),
    agent_handoff: required(mapAgentHandoff({
      sourceAgentId: 'agent-1', sourceSessionId: 'session-1', targetAgentId: 'agent-2', activityId: 'handoff-1',
    })),
    dev_environment_bound: required(mapDevEnvironmentBound({
      parentAgentId: 'agent-1', relaySessionId: 'relay-session-1',
      environmentId: 'env-1', instanceNamespace: 'nanoclaw-dev-1234abcd',
    })),
    ncl_action: required(mapNclAction({
      actor: { type: 'human', id: 'host:test' }, agentId: null, sessionId: null,
      origin: { transport: 'socket' }, action: 'groups.list', outcome: 'success', argNames: ['format'],
      resourceRefs: ['agent_group'],
    })),
  };
  return Object.fromEntries(Object.entries(inputs).map(([eventType, input]) => [
    eventType,
    pseudonymizeAuditInputWithKey(input, TEST_PSEUDONYM_KEY),
  ])) as Record<HostActivityClass, AuditEventInput>;
}

describe('nanoco.host-audit.v1 per-event profiles', () => {
  it('accepts every actual mapper profile and legitimate optional origin variant', () => {
    for (const input of Object.values(validInputs())) expect(() => buildHostAuditEventV1(input, fields)).not.toThrow();

    for (const eventType of ['response_completed', 'file_delivered'] as const) {
      for (const optional of [
        { channel_type: 'slack' },
        { messaging_group_id: 'mg-1' },
        { channel_type: 'slack', messaging_group_id: 'mg-1' },
      ]) {
        const input = structuredClone(validInputs()[eventType]);
        input.dimensions = { ...input.dimensions, ...optional };
        expect(() => buildHostAuditEventV1(input, fields)).not.toThrow();
      }
    }

    for (const dimensions of [
      { transport: 'container' as const, arg_names: [], action: 'groups.list', outcome: 'success' as const },
      {
        transport: 'container' as const, messaging_group_id: 'mg-1', arg_names: [],
        action: 'groups.list', outcome: 'success' as const,
      },
      {
        transport: 'container' as const, channel_type: 'slack', messaging_group_id: 'mg-1', arg_names: [],
        action: 'groups.list', outcome: 'success' as const,
      },
    ]) {
      expect(() => buildHostAuditEventV1({
        eventType: 'ncl_action', actor: { type: 'agent', id: 'agent-1' }, agentId: 'agent-1',
        sessionId: 'session-1', dimensions,
      }, fields)).not.toThrow();
    }
  });

  it.each(Object.entries({
    message_received: 'activity_id',
    response_completed: 'outcome',
    session_started: 'session_mode',
    task_created: 'resource_refs',
    task_run: 'session_kind',
    skill_created: 'resource_refs',
    skill_used: 'activity_id',
    file_delivered: 'file_classification',
    schedule_created: 'mode',
    agent_handoff: 'target_agent_id',
    dev_environment_bound: 'environment_id',
    ncl_action: 'arg_names',
  }) as Array<[HostActivityClass, string]>)('rejects %s when required dimension %s is absent', (eventType, key) => {
    const input = structuredClone(validInputs()[eventType]);
    delete (input.dimensions as Record<string, unknown>)[key];
    expect(() => buildHostAuditEventV1(input, fields)).toThrow(`missing audit dimension ${key}`);
  });

  it.each(Object.entries({
    message_received: ['action', 'groups.list'],
    response_completed: ['session_kind', 'interactive'],
    session_started: ['file_count', 1],
    task_created: ['channel_type', 'slack'],
    task_run: ['mode', 'recurring'],
    skill_created: ['target_agent_id', 'agent-2'],
    skill_used: ['error_code', 'command-failed'],
    file_delivered: ['resource_refs', ['task:private']],
    schedule_created: ['file_direction', 'outbound'],
    agent_handoff: ['arg_names', ['private']],
    dev_environment_bound: ['channel_type', 'slack'],
    ncl_action: ['session_kind', 'scheduled'],
  }) as Array<[HostActivityClass, [string, unknown]]>)('rejects cross-type dimension on %s', (eventType, [key, value]) => {
    const input = structuredClone(validInputs()[eventType]);
    (input.dimensions as Record<string, unknown>)[key] = value;
    expect(() => buildHostAuditEventV1(input, fields)).toThrow(`audit dimension ${key} is not allowed`);
  });

  it('rejects wrong identity profiles, typed refs, and impossible ncl origins', () => {
    const wrongRef = structuredClone(validInputs().task_created);
    wrongRef.dimensions!.resource_refs = ['skill:series-1'];
    expect(() => buildHostAuditEventV1(wrongRef, fields)).toThrow('task_created requires one task resource ref');

    const channelOnlyNcl = structuredClone(validInputs().ncl_action);
    channelOnlyNcl.actor = { type: 'agent', id: 'agent-1' };
    channelOnlyNcl.agentId = 'agent-1';
    channelOnlyNcl.sessionId = 'session-1';
    channelOnlyNcl.dimensions = {
      ...channelOnlyNcl.dimensions,
      transport: 'container',
      channel_type: 'slack',
    };
    expect(() => buildHostAuditEventV1(channelOnlyNcl, fields)).toThrow(
      'ncl_action channel_type requires messaging_group_id',
    );
  });

  it('exports and accepts the complete closed structural resource vocabulary', () => {
    expect(HOST_AUDIT_RESOURCE_TYPES).toEqual([
      'agent_group', 'approval', 'audit_event', 'destination', 'dev_environment', 'dropped_message', 'member',
      'messaging_group', 'policy', 'role', 'session', 'skill', 'task', 'user', 'user_dm', 'wiring',
    ]);
    for (const resourceType of HOST_AUDIT_RESOURCE_TYPES) {
      expect(isHostAuditResourceRef(resourceType)).toBe(true);
      expect(isHostAuditResourceRef(`${resourceType}:id-1`)).toBe(true);
      expect(hostAuditResourceRef(resourceType)).toBe(resourceType);
      expect(hostAuditResourceRef(resourceType, 'id-1')).toBe(`${resourceType}:id-1`);
    }
    expect(isHostAuditResourceRef('user:slack:U123')).toBe(true);
    expect(isHostAuditResourceRef('user:imessage:+15551234567')).toBe(true);
    expect(isHostAuditResourceRef(`task:${'a'.repeat(HOST_AUDIT_RESOURCE_REF_MAX_LENGTH - 5)}`)).toBe(true);
  });

  it('exports the exact field-specific privacy grammars', () => {
    expect(HOST_AUDIT_OPAQUE_ID_RE.toString()).toBe('/^[A-Za-z0-9][A-Za-z0-9_:+-]*$/');
    expect(HOST_AUDIT_RESOURCE_IDENTIFIER_RE).toBe(HOST_AUDIT_OPAQUE_ID_RE);
    expect(HOST_AUDIT_ACTION_RE.toString()).toBe(
      '/^[a-z][a-z0-9_-]*(?:\\.[a-z][a-z0-9_-]*)+$/',
    );
    expect(HOST_AUDIT_ARG_NAME_RE.toString()).toBe('/^[a-z0-9_]{1,64}$/');
    expect(HOST_AUDIT_TOKEN_RE.toString()).toBe('/^[a-z0-9][a-z0-9_-]{0,63}$/');
    expect(HOST_AUDIT_SCHEDULE_MODES).toEqual(['recurring', 'one-shot']);
  });

  it('rejects schedule modes outside the closed vocabulary', () => {
    const input = structuredClone(validInputs().schedule_created);
    (input.dimensions as Record<string, unknown>).mode = 'manual';
    expect(() => buildHostAuditEventV1(input, fields)).toThrow('invalid structural mode');
  });

  it.each([
    '',
    'unknown',
    'unknown:id-1',
    'task:',
    'task:/tmp/private',
    'task:C:\\private',
    'user:person@example.com',
    'task:free text',
    'task:id?secret=value',
    'task:id#fragment',
    'task:quarterly-plan.docx',
    `task:${'a'.repeat(HOST_AUDIT_RESOURCE_REF_MAX_LENGTH - 4)}`,
  ])('rejects invalid or privacy-bearing structural resource ref %j', (resourceRef) => {
    expect(isHostAuditResourceRef(resourceRef)).toBe(false);
    const input = structuredClone(validInputs().ncl_action);
    (input.dimensions as Record<string, unknown>).resource_refs = [resourceRef];
    expect(() => buildHostAuditEventV1(input, fields)).toThrow('invalid structural resource_refs');
  });

  it('requires an already-keyed pseudonym for a structurally valid user resource ref', () => {
    const input = structuredClone(validInputs().ncl_action);
    input.dimensions!.resource_refs = ['user:slack:U04T3K9'];
    expect(isHostAuditResourceRef('user:slack:U04T3K9')).toBe(true);
    expect(() => buildHostAuditEventV1(input, fields)).toThrow('invalid structural resource_refs');
    input.dimensions!.resource_refs = [`user:hmac:${'a'.repeat(64)}`];
    expect(() => buildHostAuditEventV1(input, fields)).not.toThrow();
  });

  it.each([
    '/private/groups.list',
    'groups.private report',
    'groups',
    'Groups.list',
  ])('rejects path, free-text, or non-structural ncl action %j', (action) => {
    const input = structuredClone(validInputs().ncl_action);
    input.dimensions!.action = action;
    expect(() => buildHostAuditEventV1(input, fields)).toThrow('invalid structural action');
  });

  it.each([
    'person@example.com',
    'private report',
    '../private',
    'UPPER',
  ])('rejects privacy-bearing or non-structural arg name %j', (argName) => {
    const input = structuredClone(validInputs().ncl_action);
    input.dimensions!.arg_names = [argName];
    expect(() => buildHostAuditEventV1(input, fields)).toThrow('invalid structural arg_names');
  });

  it.each([
    '/private/message',
    'quarterly-plan.docx',
    'message with text',
    'person@example.com',
  ])('rejects privacy-bearing activity_id %j', (activityId) => {
    const input = structuredClone(validInputs().message_received);
    input.dimensions!.activity_id = activityId;
    expect(() => buildHostAuditEventV1(input, fields)).toThrow('invalid structural activity_id');
  });

  it.each([
    ['channel_type', 'slack.com'],
    ['channel_type', '/private/slack'],
    ['channel_type', 'Slack'],
    ['session_mode', 'per.thread'],
    ['session_mode', 'private mode'],
  ] as const)('rejects non-token %s %j', (key, value) => {
    const input = structuredClone(validInputs().session_started);
    input.dimensions![key] = value;
    expect(() => buildHostAuditEventV1(input, fields)).toThrow(`invalid structural ${key}`);
  });

  it('requires keyed pseudonyms instead of raw namespaced human identities', () => {
    const input = structuredClone(validInputs().ncl_action);
    input.actor!.id = 'email:alice@example.com';
    expect(() => buildHostAuditEventV1(input, fields)).toThrow(/keyed Host audit pseudonym/);
    expect(HOST_AUDIT_HUMAN_PSEUDONYM_RE.test(input.actor!.id)).toBe(false);
  });

  it.each([
    ['messaging_group_id', 'group/private'],
    ['target_agent_id', 'agent.private'],
    ['source_session_id', 'private session'],
    ['correlation_id', 'person@example.com'],
  ] as const)('rejects privacy-bearing dimension id %s %j', (key, value) => {
    const input = key === 'target_agent_id' || key === 'source_session_id'
      ? structuredClone(validInputs().agent_handoff)
      : key === 'correlation_id'
        ? structuredClone(validInputs().ncl_action)
        : structuredClone(validInputs().message_received);
    (input.dimensions as Record<string, unknown>)[key] = value;
    expect(() => buildHostAuditEventV1(input, fields)).toThrow(`invalid structural ${key}`);
  });

  it('exports and enforces the closed ncl error vocabulary and outcome relationship', () => {
    expect(HOST_AUDIT_ERROR_CODES).toEqual([
      'exception', 'unknown-command', 'forbidden', 'command-failed',
    ]);
    for (const errorCode of ['exception', 'unknown-command', 'command-failed'] as const) {
      const input = structuredClone(validInputs().ncl_action);
      input.dimensions!.outcome = 'failure';
      input.dimensions!.error_code = errorCode;
      expect(() => buildHostAuditEventV1(input, fields)).not.toThrow();
    }
    const denied = structuredClone(validInputs().ncl_action);
    denied.dimensions!.outcome = 'denied';
    denied.dimensions!.error_code = 'forbidden';
    expect(() => buildHostAuditEventV1(denied, fields)).not.toThrow();
  });

  it.each(['private failure text', 'person@example.com'])('rejects non-enum error code %j', (errorCode) => {
    const input = structuredClone(validInputs().ncl_action);
    input.dimensions!.outcome = 'failure';
    (input.dimensions as Record<string, unknown>).error_code = errorCode;
    expect(() => buildHostAuditEventV1(input, fields)).toThrow('invalid structural error_code');
  });

  it.each([
    ['failure', undefined, 'failed ncl_action requires a failure error_code'],
    ['failure', 'forbidden', 'failed ncl_action requires a failure error_code'],
    ['denied', undefined, 'denied ncl_action requires forbidden error_code'],
    ['denied', 'command-failed', 'denied ncl_action requires forbidden error_code'],
    ['success', 'forbidden', 'success ncl_action must not include error_code'],
    ['approved', 'command-failed', 'approved ncl_action must not include error_code'],
    ['pending', 'command-failed', 'pending ncl_action must not include error_code'],
  ] as const)('rejects ncl outcome %s with error %s', (outcome, errorCode, message) => {
    const input = structuredClone(validInputs().ncl_action);
    input.dimensions!.outcome = outcome;
    if (errorCode === undefined) delete input.dimensions!.error_code;
    else input.dimensions!.error_code = errorCode;
    expect(() => buildHostAuditEventV1(input, fields)).toThrow(message);
  });

  it.each([
    ['message_received', 'transport', 'socket'],
    ['response_completed', 'outcome', 'failure'],
    ['session_started', 'session_kind', 'scheduled'],
    ['task_created', 'transport', 'channel'],
    ['task_run', 'transport', 'socket'],
    ['skill_created', 'transport', 'channel'],
    ['skill_used', 'transport', 'socket'],
    ['file_delivered', 'file_direction', 'inbound'],
    ['agent_handoff', 'outcome', 'failure'],
  ] as Array<[HostActivityClass, string, string]>)('rejects %s with invalid fixed %s', (eventType, key, value) => {
    const input = structuredClone(validInputs()[eventType]);
    (input.dimensions as Record<string, unknown>)[key] = value;
    expect(() => buildHostAuditEventV1(input, fields)).toThrow(`invalid ${eventType} dimension ${key}`);
  });

  it.each([
    'response_completed', 'session_started', 'task_created', 'task_run', 'skill_created', 'skill_used',
    'file_delivered', 'schedule_created', 'agent_handoff', 'ncl_action',
  ] as HostActivityClass[])('requires the frozen actor identity on %s', (eventType) => {
    expect(() => buildHostAuditEventV1({ ...validInputs()[eventType], actor: null }, fields)).toThrow(
      `${eventType} requires actor`,
    );
  });

  it.each([
    'message_received', 'response_completed', 'session_started', 'task_run', 'skill_created', 'skill_used',
    'file_delivered', 'agent_handoff',
  ] as HostActivityClass[])('requires agent_id on %s', (eventType) => {
    expect(() => buildHostAuditEventV1({ ...validInputs()[eventType], agentId: null }, fields)).toThrow(
      `${eventType} requires agent_id`,
    );
  });

  it.each([
    'message_received', 'response_completed', 'session_started', 'task_run', 'skill_used', 'file_delivered',
    'agent_handoff',
  ] as HostActivityClass[])('requires session_id on %s', (eventType) => {
    expect(() => buildHostAuditEventV1({ ...validInputs()[eventType], sessionId: null }, fields)).toThrow(
      `${eventType} requires session_id`,
    );
  });

  it('enforces transport-bound ncl actor and envelope identities', () => {
    const socket = validInputs().ncl_action;
    expect(() => buildHostAuditEventV1({
      ...socket, actor: { type: 'agent', id: 'agent-1' }, agentId: 'agent-1', sessionId: 'session-1',
    }, fields)).toThrow('socket ncl_action requires human actor and null agent/session');

    const container = structuredClone(socket);
    container.dimensions!.transport = 'container';
    expect(() => buildHostAuditEventV1(container, fields)).toThrow(
      'container ncl_action requires agent actor and agent/session',
    );
  });

  it('enforces actor identity emitted by each live mapper', () => {
    const wrongMessageActor = { ...validInputs().message_received, actor: { type: 'agent' as const, id: 'agent-1' } };
    expect(() => buildHostAuditEventV1(wrongMessageActor, fields)).toThrow(
      'message_received actor must be human or null',
    );

    for (const eventType of ['response_completed', 'file_delivered', 'skill_used'] as const) {
      const wrongType = { ...validInputs()[eventType], actor: { type: 'human' as const, id: 'agent-1' } };
      expect(() => buildHostAuditEventV1(wrongType, fields)).toThrow(`${eventType} actor must equal agent_id`);
      const wrongId = { ...validInputs()[eventType], actor: { type: 'agent' as const, id: 'agent-other' } };
      expect(() => buildHostAuditEventV1(wrongId, fields)).toThrow(`${eventType} actor must equal agent_id`);
    }

    for (const eventType of ['session_started', 'task_run'] as const) {
      const wrongSystem = { ...validInputs()[eventType], actor: { type: 'system' as const, id: 'other-host' } };
      expect(() => buildHostAuditEventV1(wrongSystem, fields)).toThrow(
        `${eventType} actor must be nanoclaw-host`,
      );
    }

    const wrongHandoffActor = { ...validInputs().agent_handoff, actor: { type: 'agent' as const, id: 'agent-other' } };
    expect(() => buildHostAuditEventV1(wrongHandoffActor, fields)).toThrow(
      'agent_handoff actor must equal agent_id',
    );
    const wrongHandoffSession = structuredClone(validInputs().agent_handoff);
    wrongHandoffSession.dimensions!.source_session_id = 'session-other';
    expect(() => buildHostAuditEventV1(wrongHandoffSession, fields)).toThrow(
      'agent_handoff source_session_id must equal session_id',
    );
  });

  it.each(['task_created', 'schedule_created', 'skill_created'] as const)(
    'couples %s actor type to its transport without requiring actor/target equality',
    (eventType) => {
      const socketAgent = structuredClone(validInputs()[eventType]);
      socketAgent.dimensions!.transport = 'socket';
      socketAgent.actor = { type: 'agent', id: 'operator-agent' };
      expect(() => buildHostAuditEventV1(socketAgent, fields)).toThrow(
        `${eventType} socket transport requires human actor`,
      );

      const containerHuman = structuredClone(validInputs()[eventType]);
      containerHuman.actor = { type: 'human', id: `hmac:${'a'.repeat(64)}` };
      expect(() => buildHostAuditEventV1(containerHuman, fields)).toThrow(
        `${eventType} container transport requires agent actor`,
      );
    },
  );

  it('requires container ncl actor.id to equal agent_id', () => {
    const input = structuredClone(validInputs().ncl_action);
    input.dimensions!.transport = 'container';
    input.actor = { type: 'agent', id: 'agent-other' };
    input.agentId = 'agent-1';
    input.sessionId = 'session-1';
    expect(() => buildHostAuditEventV1(input, fields)).toThrow(
      'container ncl_action actor must equal agent_id',
    );
  });
});
