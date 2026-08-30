/**
 * Audit middleware behavior of the exported dispatch — what gets recorded,
 * for whom, and how gated chains correlate. Drives the real wrapped dispatch
 * (real registry, real guard); audit is force-enabled and the store's append
 * is captured. DB reads and approval delivery are mocked.
 *
 * Recording model under test: structural dimensions store arg KEY NAMES and
 * derived action/outcome only. Caller-controlled values never cross the
 * adapter, so a secret-bearing arg leaves only its key behind.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PendingApproval } from '../types.js';

const appended = vi.hoisted(() => ({ lines: [] as string[] }));
const pendingRows = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock('../audit/config.js', () => ({
  AUDIT_ENABLED: true,
  AUDIT_RETENTION_HOURS: 12,
  AUDIT_HOST_ID: 'deployment-test-01',
}));

// Neutralize inert lifecycle registration — the middleware is the unit under
// test here.
vi.mock('../audit/init.js', () => ({
  initAuditLog: vi.fn(),
  maintainAudit: vi.fn(),
}));

// Pseudonym behavior has its own keyed boundary tests; this suite isolates
// dispatcher action/resource resolution.
vi.mock('../audit/pseudonym.js', () => ({
  pseudonymizeAuditInput: (input: { actor?: { type?: string; id?: string } }) => input.actor?.type === 'human'
    ? { ...input, actor: { ...input.actor, id: `hmac:${'a'.repeat(64)}` } }
    : input,
}));

vi.mock('../audit/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../audit/store.js')>();
  return {
    ...actual,
    appendAuditEvent: (build: (seq: number) => Record<string, unknown>) => {
      const event = build(appended.lines.length + 1);
      const line = JSON.stringify(event);
      appended.lines.push(line);
      return { event, line };
    },
  };
});

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

const mockGetContainerConfig = vi.fn();
vi.mock('../db/container-configs.js', () => ({
  getContainerConfig: (...args: unknown[]) => mockGetContainerConfig(...args),
}));

vi.mock('../db/agent-groups.js', () => ({
  getAgentGroup: vi.fn(() => ({ id: 'g1', name: 'Group One' })),
}));

const mockGetPendingApproval = vi.fn();
vi.mock('../db/sessions.js', () => ({
  getSession: vi.fn(() => ({ id: 's1', agent_group_id: 'g1', messaging_group_id: 'mg1' })),
  getPendingApproval: (...args: unknown[]) => mockGetPendingApproval(...args),
  getPendingApprovalsByAction: () => pendingRows.rows,
}));

const mockGetMessagingGroup = vi.fn((_id: string) => ({ channel_type: 'slack' }));
vi.mock('../db/messaging-groups.js', () => ({
  getMessagingGroup: (id: string) => mockGetMessagingGroup(id),
}));

const mockGetResource = vi.fn();
vi.mock('./crud.js', () => ({
  getResource: (...args: unknown[]) => mockGetResource(...args),
}));

const mockRequestApproval = vi.fn();
vi.mock('../modules/approvals/index.js', () => ({
  registerApprovalHandler: vi.fn(),
  requestApproval: (...args: unknown[]) => mockRequestApproval(...args),
}));

import { type CommandDef, register } from './registry.js';

register({
  name: 'groups-test',
  description: 'echo command on the groups resource',
  action: 'groups.test',
  resource: 'groups',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'groups-get',
  description: 'echo command for dash-joined id resolution',
  action: 'groups.get',
  resource: 'groups',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'wirings-list',
  description: 'not on the group-scope allowlist',
  action: 'wirings.list',
  resource: 'wirings',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async () => [],
});

register({
  name: 'groups-fail',
  description: 'handler that throws',
  action: 'groups.fail',
  resource: 'groups',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async () => {
    throw new Error('boom');
  },
});

register({
  name: 'groups-invalid',
  description: 'command whose parser rejects private caller input',
  action: 'groups.invalid',
  resource: 'groups',
  access: 'open',
  parseArgs: () => {
    throw new Error('person@example.com /private/path free text');
  },
  handler: async () => 'unreachable',
});

register({
  name: 'groups-gated',
  description: 'approval-gated command',
  action: 'groups.gated',
  resource: 'groups',
  access: 'approval',
  parseArgs: (raw) => raw,
  handler: async () => 'ran',
});

register({
  name: 'roles-grant',
  description: 'command carrying an allowlisted --role value',
  action: 'roles.grant',
  resource: 'roles',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async () => ({ granted: true }),
});

import { dispatch } from './dispatch.js';
import {
  HOST_AUDIT_CLI_RESOURCE_TYPES,
  normalizeNclAuditErrorCode,
  resourcesForCli,
} from './dispatch.audit.js';
import type { CallerContext } from './frame.js';
import { log } from '../log.js';

const AGENT_CTX: CallerContext = { caller: 'agent', sessionId: 's1', agentGroupId: 'g1', messagingGroupId: 'mg1' };

function grantRow(frameId: string, command: string): PendingApproval {
  return {
    approval_id: 'appr-123-abc',
    session_id: 's1',
    request_id: 'appr-123-abc',
    action: 'cli_command',
    payload: JSON.stringify({ frame: { id: frameId, command, args: {} }, callerContext: AGENT_CTX }),
    created_at: new Date().toISOString(),
    agent_group_id: 'g1',
    channel_type: null,
    instance: null,
    platform_id: null,
    platform_message_id: null,
    expires_at: null,
    status: 'pending',
    title: 'CLI: groups-gated',
    question: 'Run the gated command?',
    options_json: '[]',
    approver_user_id: null,
  };
}

function events(): Array<Record<string, any>> {
  return appended.lines.map((l) => JSON.parse(l));
}

function commandForResource(resource: string): CommandDef {
  return {
    name: `${resource}-audit-contract`,
    description: 'audit resource contract probe',
    action: `${resource}.probe`,
    resource,
    access: 'open',
    parseArgs: (raw) => raw,
    handler: async () => null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  appended.lines.length = 0;
  pendingRows.rows = [];
  mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
  mockGetResource.mockImplementation((plural: string) => (plural === 'groups' ? { scopeField: 'id' } : undefined));
  mockRequestApproval.mockResolvedValue(undefined);
});

describe('withAudit(dispatch)', () => {
  it('maps every live ncl resource plural into the closed audit vocabulary', () => {
    const expected = {
      approvals: 'approval',
      audit: 'audit_event',
      destinations: 'destination',
      'dropped-messages': 'dropped_message',
      groups: 'agent_group',
      members: 'member',
      'messaging-groups': 'messaging_group',
      policies: 'policy',
      roles: 'role',
      sessions: 'session',
      tasks: 'task',
      'user-dms': 'user_dm',
      users: 'user',
      wirings: 'wiring',
    } as const;
    expect(HOST_AUDIT_CLI_RESOURCE_TYPES).toEqual(expected);
    for (const [plural, resourceType] of Object.entries(expected)) {
      expect(resourcesForCli(commandForResource(plural), {})).toEqual([resourceType]);
      expect(resourcesForCli(commandForResource(plural), { id: 'id-1' })).toEqual([`${resourceType}:id-1`]);
    }
  });

  it('rejects path, email, free-text, oversized, and unknown resource targets', () => {
    for (const identifier of [
      '/private/path',
      'C:\\private\\path',
      'person@example.com',
      'free text target',
      'quarterly-plan.docx',
      'a'.repeat(257),
    ]) {
      expect(resourcesForCli(commandForResource('groups'), { id: identifier })).toEqual(['agent_group']);
    }
    expect(resourcesForCli(commandForResource('not-live'), { id: 'id-1' })).toEqual([]);
    expect(resourcesForCli(commandForResource('tasks'), {
      group: 'group-1',
      user: 'slack:U123',
    })).toEqual(['agent_group:group-1', 'user:slack:U123']);
  });

  it('normalizes every live dispatcher error into the closed audit enum', () => {
    expect(normalizeNclAuditErrorCode('unknown-command')).toBe('unknown-command');
    expect(normalizeNclAuditErrorCode('forbidden')).toBe('forbidden');
    expect(normalizeNclAuditErrorCode('invalid-args')).toBe('command-failed');
    expect(normalizeNclAuditErrorCode('handler-error')).toBe('command-failed');
    expect(normalizeNclAuditErrorCode('transport-error')).toBe('command-failed');
    expect(normalizeNclAuditErrorCode('approval-pending')).toBeNull();
  });

  it('records a success event for a host caller with socket origin and host actor', async () => {
    const resp = await dispatch({ id: '1', command: 'groups-test', args: { foo: 'bar' } }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    const [event] = events();
    expect(event).toMatchObject({
      schema_version: 'nanoco.host-audit.v1',
      host_id: 'deployment-test-01',
      seq: 1,
      event_type: 'ncl_action',
      actor: { type: 'human', id: `hmac:${'a'.repeat(64)}` },
      agent_id: null,
      session_id: null,
      dimensions: { transport: 'socket', action: 'groups.test', outcome: 'success', arg_names: ['foo'] },
    });
    // The value 'bar' is never stored — only the key name.
    expect(event.dimensions.foo).toBeUndefined();
  });

  it('records an agent command value-free, with container origin and channel', async () => {
    await dispatch({ id: '1', command: 'groups-test', args: {} }, AGENT_CTX);

    const [event] = events();
    expect(event.actor).toMatchObject({ type: 'agent', id: 'g1' });
    expect(event.agent_id).toBe('g1');
    expect(event.session_id).toBe('s1');
    expect(event.dimensions).toMatchObject({
      transport: 'container',
      messaging_group_id: 'mg1',
      channel_type: 'slack',
      action: 'groups.test',
      outcome: 'success',
      arg_names: [],
    });
    expect(event.dimensions.resource_refs).toContain('agent_group');
  });

  it('keeps the command fail-open and logs loudly when async origin enrichment fails', async () => {
    mockGetMessagingGroup.mockRejectedValueOnce(new Error('messaging group read failed'));

    const resp = await dispatch({ id: '1', command: 'groups-test', args: {} }, AGENT_CTX);

    expect(resp.ok).toBe(true);
    expect(events()).toEqual([]);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('derivation failed'),
      expect.objectContaining({ command: 'groups-test' }),
    );
  });

  it('records passed flag names without copying any caller-controlled values', async () => {
    await dispatch(
      {
        id: '1',
        command: 'groups-test',
        args: {
          role: 'sentinel-role',
          mode: 'sentinel-mode',
          session_mode: 'sentinel-session-mode',
          cli_scope: 'sentinel-cli-scope',
          access: 'sentinel-access',
          engage_mode: 'sentinel-engage-mode',
          sender_scope: 'sentinel-sender-scope',
          provider: 'sentinel-provider',
          model: 'sentinel-model',
          'person@example.com': 'sentinel-email-key',
          'private report': 'sentinel-free-text-key',
          '../path': 'sentinel-path-key',
        },
      },
      { caller: 'host' },
    );

    const [event] = events();
    expect(event.dimensions.action).toBe('groups.test');
    expect(event.dimensions.arg_names).toEqual([
      'access',
      'cli_scope',
      'engage_mode',
      'mode',
      'model',
      'provider',
      'role',
      'sender_scope',
      'session_mode',
    ]);
    expect(appended.lines[0]).not.toContain('sentinel-');
    for (const key of event.dimensions.arg_names) {
      if (key !== 'action' && key !== 'outcome') expect(event.dimensions[key]).toBeUndefined();
    }
  });

  it('omits an invalid channel origin rather than persisting it', async () => {
    mockGetMessagingGroup.mockReturnValueOnce({ channel_type: 'slack.com' });
    await dispatch({ id: '1', command: 'groups-test', args: {} }, AGENT_CTX);

    const [event] = events();
    expect(event.dimensions.transport).toBe('container');
    expect(event.dimensions.channel_type).toBeUndefined();
    expect(event.dimensions.messaging_group_id).toBeUndefined();
    expect(appended.lines[0]).not.toContain('slack.com');
  });

  it('records a denied event for a scope denial, naming the attempted resource type, with no free-text reason', async () => {
    const resp = await dispatch({ id: '1', command: 'wirings-list', args: {} }, AGENT_CTX);

    expect(resp.ok).toBe(false);
    const [event] = events();
    expect(event).toMatchObject({
      dimensions: {
        action: 'wirings.list',
        outcome: 'denied',
        resource_refs: ['wiring'],
        arg_names: [],
        error_code: 'forbidden',
      },
    });
    // The denial message (which can echo caller input) is never stored.
    expect(event.dimensions.reason).toBeUndefined();
  });

  it('normalizes a handler error without storing its message', async () => {
    await dispatch({ id: '1', command: 'groups-fail', args: {} }, { caller: 'host' });

    const [event] = events();
    expect(event.dimensions).toMatchObject({
      action: 'groups.fail', outcome: 'failure', error_code: 'command-failed',
    });
    expect(event.dimensions.reason).toBeUndefined();
  });

  it('normalizes invalid args without storing rejected path, email, or free text', async () => {
    await dispatch({ id: '1', command: 'groups-invalid', args: { target: 'private' } }, { caller: 'host' });

    const [event] = events();
    expect(event.dimensions).toMatchObject({
      action: 'groups.invalid', outcome: 'failure', error_code: 'command-failed',
    });
    expect(appended.lines[0]).not.toContain('person@example.com');
    expect(appended.lines[0]).not.toContain('/private/path');
    expect(appended.lines[0]).not.toContain('free text');
  });

  it('records a failure event and re-throws when the dispatcher itself throws', async () => {
    mockRequestApproval.mockRejectedValueOnce(new Error('pending_approvals insert failed'));

    await expect(dispatch({ id: '1', command: 'groups-gated', args: {} }, AGENT_CTX)).rejects.toThrow(
      'pending_approvals insert failed',
    );

    const [event] = events();
    expect(event.dimensions).toMatchObject({ action: 'groups.gated', outcome: 'failure', error_code: 'exception' });
  });

  it('records a hold as a pending event correlated to the approval row it created', async () => {
    pendingRows.rows = [grantRow('1', 'groups-gated')];

    const resp = await dispatch({ id: '1', command: 'groups-gated', args: {} }, AGENT_CTX);

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('approval-pending');
    const [event] = events();
    expect(event).toMatchObject({
      dimensions: { action: 'groups.gated', outcome: 'pending', correlation_id: 'appr-123-abc' },
    });
    expect(event.dimensions.resource_refs).toContain('approval:appr-123-abc');
    expect(event.dimensions.error_code).toBeUndefined();
  });

  it('records an uncorrelated pending event when no approval row was created (no approver)', async () => {
    pendingRows.rows = [];

    await dispatch({ id: '1', command: 'groups-gated', args: {} }, AGENT_CTX);

    const [event] = events();
    expect(event.dimensions).toMatchObject({ outcome: 'pending' });
    expect(event.dimensions.correlation_id).toBeUndefined();
  });

  it('records an approved replay as an `approved` event with the grant approval id', async () => {
    const grant = grantRow('9', 'groups-gated');
    mockGetPendingApproval.mockReturnValue(grant);

    const resp = await dispatch({ id: '9', command: 'groups-gated', args: {} }, AGENT_CTX, { grant });

    expect(resp.ok).toBe(true);
    const [event] = events();
    expect(event).toMatchObject({
      dimensions: { action: 'groups.gated', outcome: 'approved', correlation_id: 'appr-123-abc' },
    });
    expect(event.dimensions.resource_refs).toContain('approval:appr-123-abc');
  });

  it('records a --help probe under a neutral cli.help action, never the real verb', async () => {
    const resp = await dispatch({ id: '1', command: 'groups-gated', args: { help: true } }, AGENT_CTX);

    expect(resp.ok).toBe(true);
    const [event] = events();
    expect(event.dimensions.action).toBe('cli.help');
    expect(event.dimensions.outcome).toBe('success');
    expect(event.dimensions.resource_refs).toBeUndefined();
  });

  it('records unknown commands under a fixed structural name without storing raw input', async () => {
    await dispatch({ id: '1', command: 'nope-nothing', args: {} }, { caller: 'host' });

    const [event] = events();
    expect(event).toMatchObject({
      dimensions: { action: 'cli.unknown-command', outcome: 'failure', arg_names: [], error_code: 'unknown-command' },
    });
    expect(appended.lines[0]).not.toContain('nope-nothing');
  });

  it('records the resolved command and target id for dash-joined positional ids', async () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    await dispatch({ id: '1', command: `groups-get-${uuid}`, args: {} }, { caller: 'host' });

    const [event] = events();
    expect(event.dimensions).toMatchObject({ action: 'groups.get', outcome: 'success' });
    expect(event.dimensions.resource_refs).toContain(`agent_group:${uuid}`);
    // The id surfaces in resources; details keeps only the flag name.
    expect(event.dimensions.arg_names).toContain('id');
    expect(event.dimensions.id).toBeUndefined();
  });

  it('normalizes hyphenated arg key names in details', async () => {
    await dispatch({ id: '1', command: 'groups-test', args: { 'dry-run': 'true' } }, { caller: 'host' });

    const [event] = events();
    expect(event.dimensions.arg_names).toContain('dry_run');
    expect(event.dimensions.dry_run).toBeUndefined();
  });

  it('never stores arg values — a secret-bearing arg leaves only its key', async () => {
    await dispatch(
      { id: '1', command: 'groups-test', args: { env: '{"NOTION_TOKEN":"tok-123","SAFE":"ok"}' } },
      { caller: 'host' },
    );

    const [event] = events();
    expect(event.dimensions.arg_names).toContain('env');
    expect(event.dimensions.env).toBeUndefined();
    // The secret never reaches the stored bytes.
    expect(appended.lines[0]).not.toContain('NOTION_TOKEN');
    expect(appended.lines[0]).not.toContain('tok-123');
  });
});
