import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks ---

const approvalState = vi.hoisted(() => ({
  requestApproval: vi.fn(),
  approvalHandler: null as
    | null
    | ((args: {
        session: unknown;
        payload: Record<string, unknown>;
        approval: Record<string, unknown>;
        userId: string;
        notify: (text: string) => void;
      }) => Promise<void>),
  registerApprovalHandler: vi.fn(
    (
      action: string,
      handler: (args: {
        session: unknown;
        payload: Record<string, unknown>;
        approval: Record<string, unknown>;
        userId: string;
        notify: (text: string) => void;
      }) => Promise<void>,
    ) => {
      if (action === 'cli_command') approvalState.approvalHandler = handler;
    },
  ),
  observedContexts: [] as CallerContext[],
}));

vi.mock('../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockGetContainerConfig = vi.fn();
vi.mock('../db/container-configs.js', () => ({
  getContainerConfig: (...args: unknown[]) => mockGetContainerConfig(...args),
}));

const mockGetAgentGroup = vi.fn();
vi.mock('../db/agent-groups.js', () => ({
  getAgentGroup: (...args: unknown[]) => mockGetAgentGroup(...args),
}));

const mockGetSession = vi.fn();
// The guard's grant check re-fetches the approval row to prove it's live.
const mockGetPendingApproval = vi.fn();
vi.mock('../db/sessions.js', () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  getPendingApproval: (...args: unknown[]) => mockGetPendingApproval(...args),
}));

// dispatch's post-handler looks up the resource's `scopeField` via getResource.
// The real resources aren't registered in this unit test, so mock it.
const mockGetResource = vi.fn();
vi.mock('./crud.js', () => ({
  getResource: (...args: unknown[]) => mockGetResource(...args),
}));

vi.mock('../modules/approvals/index.js', () => ({
  registerApprovalHandler: approvalState.registerApprovalHandler,
  requestApproval: approvalState.requestApproval,
}));

// Register a test command so dispatch has something to find
import { register } from './registry.js';

register({
  name: 'test-cmd',
  description: 'test command (non-group resource)',
  resource: 'test',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'groups-test',
  description: 'test command (groups resource)',
  resource: 'groups',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'general-cmd',
  description: 'test command (no resource, like help)',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'sessions-list',
  description: 'test command (sessions resource)',
  resource: 'sessions',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'destinations-list',
  description: 'test command (destinations resource)',
  resource: 'destinations',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'members-add',
  description: 'test command (members resource)',
  resource: 'members',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'tasks-list',
  description: 'test command (tasks resource)',
  resource: 'tasks',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'wirings-list',
  description: 'test command (wirings resource — not allowed)',
  resource: 'wirings',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'host-only-cmd',
  description: 'test command (operator-only, like add-mount)',
  resource: 'groups',
  access: 'approval',
  hostOnly: true,
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'approval-context-command',
  description: 'approval command that records caller context',
  resource: 'groups',
  access: 'approval',
  parseArgs: (raw) => raw,
  handler: async (_args, ctx) => {
    approvalState.observedContexts.push(ctx);
    return { caller: ctx.caller };
  },
});

// Commands that return data shaped like real resources (for post-handler filtering tests)
register({
  name: 'groups-list-data',
  description: 'returns mock group rows',
  resource: 'groups',
  access: 'open',
  generic: 'list',
  parseArgs: (raw) => raw,
  handler: async () => [
    { id: 'g1', name: 'my-group' },
    { id: 'g2', name: 'other-group' },
  ],
});

register({
  name: 'sessions-get-data',
  description: 'returns a mock session row',
  resource: 'sessions',
  access: 'open',
  generic: 'get',
  parseArgs: (raw) => raw,
  handler: async (args) => ({
    id: args.id,
    agent_group_id: (args as Record<string, unknown>).belongs_to ?? 'g1',
  }),
});

// A custom op under the `groups` resource that returns a config-shaped object
// (no `id` key). The post-handler must not touch this — only `generic` handlers.
register({
  name: 'groups-config-get',
  description: 'custom op returning a config object (no id)',
  resource: 'groups',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async () => ({ agent_group_id: 'g1', model: 'opus' }),
});

// A dash-joined command whose custom-operation key contains spaces
// ('config update') — used by the --help space/dash bridging test.
register({
  name: 'groups-config-update',
  description: 'bare registry description (should not be the help answer)',
  resource: 'groups',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

// The real `sessions-get` name — triggers the pre-handler ownership check.
register({
  name: 'sessions-get',
  description: 'generic sessions get',
  resource: 'sessions',
  access: 'open',
  generic: 'get',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ id: (args as Record<string, unknown>).id, agent_group_id: 'g1' }),
});

// Echoes args back — used to assert dash-joined positional id resolution.
register({
  name: 'groups-get',
  description: 'test command (groups get)',
  resource: 'groups',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

import { dispatch } from './dispatch.js';
import type { CallerContext } from './frame.js';

beforeEach(() => {
  vi.clearAllMocks();
  approvalState.observedContexts.length = 0;
  // Default: the four CLI-whitelisted resources with their real scopeFields.
  const scopeFields: Record<string, string> = {
    groups: 'id',
    sessions: 'agent_group_id',
    destinations: 'agent_group_id',
    members: 'agent_group_id',
    tasks: 'agent_group_id',
  };
  mockGetResource.mockImplementation((plural: string) =>
    scopeFields[plural] ? { scopeField: scopeFields[plural] } : undefined,
  );
});

// --- Helpers ---

function agentCtx(overrides?: Partial<Extract<CallerContext, { caller: 'agent' }>>): CallerContext {
  return {
    caller: 'agent',
    sessionId: 's1',
    agentGroupId: 'g1',
    messagingGroupId: 'mg1',
    ...overrides,
  };
}

// --- Tests ---

describe('host-only commands (operator-only)', () => {
  it('rejects an agent caller even at global scope', async () => {
    // global scope is otherwise unrestricted — hostOnly must still reject.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });
    const resp = await dispatch({ id: '1', command: 'host-only-cmd', args: {} }, agentCtx());
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('operator-only');
    }
  });

  it('passes the gate for a host (operator) caller', async () => {
    const resp = await dispatch({ id: '1', command: 'host-only-cmd', args: { x: 1 } }, { caller: 'host' });
    expect(resp.ok).toBe(true);
  });
});

describe('CLI scope enforcement', () => {
  it('disabled: rejects all CLI requests from agent', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'disabled' });

    const resp = await dispatch({ id: '1', command: 'test-cmd', args: {} }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('disabled');
    }
  });

  it('group: auto-fills --id with caller agent group', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'groups-test', args: { foo: 'bar' } }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as { echo: Record<string, unknown> };
      expect(data.echo.id).toBe('g1');
    }
  });

  it('group: rejects cross-group access', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'groups-test', args: { id: 'other-group' } }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('scoped');
    }
  });

  it('group: allows same-group id', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'groups-test', args: { id: 'g1' } }, agentCtx());

    expect(resp.ok).toBe(true);
  });

  it('group: blocks cli_scope escalation', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'groups-test', args: { cli_scope: 'global' } }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('cli_scope');
    }
  });

  it('group: blocks cli-scope escalation (hyphenated)', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'groups-test', args: { 'cli-scope': 'global' } }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
    }
  });

  it('group: blocks non-group resources', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'test-cmd', args: {} }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('test');
    }
  });

  it('group: allows general commands with no resource (e.g. help)', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'general-cmd', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
  });

  it('group: allows sessions, auto-fills --agent_group_id', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'sessions-list', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as { echo: Record<string, unknown> };
      expect(data.echo.agent_group_id).toBe('g1');
      // --id should NOT be auto-filled for sessions (it's session UUID, not group)
      expect(data.echo.id).toBeUndefined();
    }
  });

  it('group: allows destinations, auto-fills --id', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'destinations-list', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as { echo: Record<string, unknown> };
      expect(data.echo.id).toBe('g1');
    }
  });

  it('group: allows members, auto-fills --group', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'members-add', args: { user: 'u1' } }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as { echo: Record<string, unknown> };
      expect(data.echo.group).toBe('g1');
    }
  });

  it('group: allows tasks, auto-fills --group', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'tasks-list', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as { echo: Record<string, unknown> };
      expect(data.echo.group).toBe('g1');
      expect(data.echo.id).toBeUndefined();
    }
  });

  it('group: blocks non-whitelisted resources (wirings)', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'wirings-list', args: {} }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('wirings');
    }
  });

  it('group: rejects cross-group --agent_group_id', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch(
      { id: '1', command: 'sessions-list', args: { agent_group_id: 'other-group' } },
      agentCtx(),
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
    }
  });

  it('group: rejects cross-group --group', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch(
      { id: '1', command: 'members-add', args: { user: 'u1', group: 'other-group' } },
      agentCtx(),
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
    }
  });

  it('global: allows cross-group access', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    const resp = await dispatch({ id: '1', command: 'test-cmd', args: { id: 'other-group' } }, agentCtx());

    expect(resp.ok).toBe(true);
  });

  it('global: allows non-group resources', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    const resp = await dispatch({ id: '1', command: 'test-cmd', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
  });

  it('global: does not auto-fill --id', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    const resp = await dispatch({ id: '1', command: 'test-cmd', args: { foo: 'bar' } }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as { echo: Record<string, unknown> };
      expect(data.echo.id).toBeUndefined();
    }
  });

  it('defaults to group when cli_scope is missing', async () => {
    mockGetContainerConfig.mockReturnValue({});

    const resp = await dispatch({ id: '1', command: 'test-cmd', args: {} }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
    }
  });

  it('host caller bypasses CLI scope enforcement', async () => {
    // No config check should happen for host callers
    const resp = await dispatch({ id: '1', command: 'test-cmd', args: { id: 'any-group' } }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    expect(mockGetContainerConfig).not.toHaveBeenCalled();
  });

  it('approval replay preserves the original agent caller context', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    mockGetSession.mockReturnValue({ id: 's1', agent_group_id: 'g1', messaging_group_id: 'mg1' });
    mockGetAgentGroup.mockReturnValue({ id: 'g1', name: 'Group One' });

    const ctx = agentCtx();
    const resp = await dispatch({ id: '1', command: 'approval-context-command', args: {} }, ctx);

    expect(resp.ok).toBe(false);
    expect(approvalState.requestApproval).toHaveBeenCalledTimes(1);

    const approval = approvalState.requestApproval.mock.calls[0][0] as { payload: Record<string, unknown> };
    expect(approval.payload).toEqual({
      frame: {
        id: '1',
        command: 'approval-context-command',
        args: { agent_group_id: 'g1', group: 'g1', id: 'g1' },
      },
      callerContext: ctx,
    });

    // The approve path hands the handler the live approval row — the grant
    // the replay carries back into dispatch.
    const grantRow = {
      approval_id: 'appr-t1',
      action: 'cli_command',
      payload: JSON.stringify(approval.payload),
    };
    mockGetPendingApproval.mockReturnValue(grantRow);

    expect(approvalState.approvalHandler).toBeTypeOf('function');
    await approvalState.approvalHandler!({
      session: { id: 's1', agent_group_id: 'g1', messaging_group_id: 'mg1' },
      payload: approval.payload,
      approval: grantRow,
      userId: 'telegram:admin',
      notify: vi.fn(),
    });

    expect(approvalState.observedContexts).toEqual([ctx]);
    expect(approvalState.requestApproval).toHaveBeenCalledTimes(1);
  });

  // --- Grant-carrying replay (the `approved: true` boolean no longer exists) ---

  it('replay with a dead grant (row deleted) refuses instead of re-holding', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    mockGetSession.mockReturnValue({ id: 's1', agent_group_id: 'g1', messaging_group_id: 'mg1' });
    mockGetAgentGroup.mockReturnValue({ id: 'g1', name: 'Group One' });

    const ctx = agentCtx();
    await dispatch({ id: '1', command: 'approval-context-command', args: {} }, ctx);
    const approval = approvalState.requestApproval.mock.calls[0][0] as { payload: Record<string, unknown> };

    mockGetPendingApproval.mockReturnValue(undefined); // resolution already deleted the row
    const notify = vi.fn();
    await approvalState.approvalHandler!({
      session: { id: 's1', agent_group_id: 'g1', messaging_group_id: 'mg1' },
      payload: approval.payload,
      approval: { approval_id: 'appr-dead', action: 'cli_command', payload: JSON.stringify(approval.payload) },
      userId: 'telegram:admin',
      notify,
    });

    expect(approvalState.observedContexts).toHaveLength(0); // handler never ran
    expect(approvalState.requestApproval).toHaveBeenCalledTimes(1); // no second card
    expect(notify.mock.calls[0][0]).toContain('failed');
  });

  it("a grant approved for one command doesn't transfer to another", async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    // A live cli_command row, but held for a DIFFERENT command.
    const grantRow = {
      approval_id: 'appr-other',
      action: 'cli_command',
      payload: JSON.stringify({ frame: { command: 'members-add' } }),
    };
    mockGetPendingApproval.mockReturnValue(grantRow);

    const resp = await dispatch({ id: '1', command: 'approval-context-command', args: {} }, agentCtx(), {
      grant: grantRow as never,
    });

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('grant');
    }
    expect(approvalState.observedContexts).toHaveLength(0);
  });

  it('a fabricated grant object without a live row is refused', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    mockGetPendingApproval.mockReturnValue(undefined);

    const forged = {
      approval_id: 'appr-forged',
      action: 'cli_command',
      payload: JSON.stringify({ frame: { command: 'approval-context-command' } }),
    };
    const resp = await dispatch({ id: '1', command: 'approval-context-command', args: {} }, agentCtx(), {
      grant: forged as never,
    });

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('forbidden');
    expect(approvalState.requestApproval).not.toHaveBeenCalled(); // refusal, not a fresh hold
  });

  // --- Post-handler filtering ---

  it('group: groups list filters out other groups', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'groups-list-data', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as Array<{ id: string }>;
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe('g1');
    }
  });

  it('group: sessions get rejects cross-group session', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch(
      { id: '1', command: 'sessions-get-data', args: { id: 's-123', belongs_to: 'other-group' } },
      agentCtx(),
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('different agent group');
    }
  });

  it('group: sessions get allows own-group session', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch(
      { id: '1', command: 'sessions-get-data', args: { id: 's-123', belongs_to: 'g1' } },
      agentCtx(),
    );

    expect(resp.ok).toBe(true);
  });

  it('global: no post-handler filtering', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    const resp = await dispatch({ id: '1', command: 'groups-list-data', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as Array<{ id: string }>;
      expect(data).toHaveLength(2); // both groups returned
    }
  });

  // --- Custom ops bypass post-handler row filtering (regression: #2392 review) ---

  it('group: a custom op returning a non-row object is not falsely rejected', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    // groups-config-get is access:open and reachable by a group-scoped agent;
    // it returns { agent_group_id, model } with no `id` field. Before this fix
    // the post-handler compared data['id'] (undefined) and returned forbidden.
    const resp = await dispatch({ id: '1', command: 'groups-config-get', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      expect((resp.data as { model: string }).model).toBe('opus');
    }
  });

  // --- sessions-get pre-handler ownership check (no existence oracle) ---

  it('group: sessions-get returns "session not found" for a foreign session UUID', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    mockGetSession.mockReturnValue({ id: 's-x', agent_group_id: 'other-group' });

    const resp = await dispatch({ id: '1', command: 'sessions-get', args: { id: 's-x' } }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('handler-error');
      expect(resp.error.message).toContain('session not found');
    }
  });

  it('group: sessions-get returns "session not found" for a non-existent UUID', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    mockGetSession.mockReturnValue(undefined);

    const resp = await dispatch({ id: '1', command: 'sessions-get', args: { id: 's-nope' } }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('handler-error');
      expect(resp.error.message).toContain('session not found');
    }
  });

  it('group: sessions-get allows the caller’s own session', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    mockGetSession.mockReturnValue({ id: 's-mine', agent_group_id: 'g1' });

    const resp = await dispatch({ id: '1', command: 'sessions-get', args: { id: 's-mine' } }, agentCtx());

    expect(resp.ok).toBe(true);
  });

  // --- Fail-closed regression guard for a missing scopeField ---

  it('group: generic list/get fails closed when the resource declares no scopeField', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    mockGetResource.mockReturnValue(undefined); // a whitelisted resource that forgot scopeField

    const resp = await dispatch({ id: '1', command: 'groups-list-data', args: {} }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('not available in group scope');
    }
  });
});

// Multi-segment command, to prove the longest-prefix match (verb itself has dashes).
register({
  name: 'groups-cfg-get',
  description: 'test multi-segment command',
  resource: 'groups',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

describe('positional dashed-id resolution', () => {
  const host = { caller: 'host' as const };

  it('resolves a long dashed id to command + intact id (no shredding)', async () => {
    const id = 'task-374f0630-d3e0-4965-81da-fe4bf7a6a442';
    const resp = await dispatch({ id: '1', command: `groups-test-${id}`, args: {} }, host);
    expect(resp.ok).toBe(true);
    if (resp.ok) expect(resp.data).toEqual({ echo: { id } });
  });

  it('matches the LONGEST command prefix when the verb itself has dashes', async () => {
    const resp = await dispatch({ id: '2', command: 'groups-cfg-get-abc-123', args: {} }, host);
    expect(resp.ok).toBe(true);
    if (resp.ok) expect(resp.data).toEqual({ echo: { id: 'abc-123' } });
  });

  it('leaves a registered no-id command alone', async () => {
    const resp = await dispatch({ id: '3', command: 'groups-test', args: {} }, host);
    expect(resp.ok).toBe(true);
    if (resp.ok) expect(resp.data).toEqual({ echo: {} });
  });

  it('does not override an explicit --id', async () => {
    const resp = await dispatch({ id: '4', command: 'groups-test-tail', args: { id: 'explicit' } }, host);
    expect(resp.ok).toBe(true);
    if (resp.ok) expect(resp.data).toEqual({ echo: { id: 'explicit' } });
  });
});

// --- `--help` interception: answer with generated help, execute nothing ---

describe('--help interception', () => {
  it('returns command help instead of executing (open command)', async () => {
    const resp = await dispatch({ id: '1', command: 'test-cmd', args: { help: true } }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      // No deep resource def for 'test' → falls back to the description.
      expect(resp.data).toBe('test command (non-group resource)');
    }
  });

  it('carries the help text in `human` so clients print it verbatim', async () => {
    const resp = await dispatch({ id: '1', command: 'test-cmd', args: { help: true } }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      expect(typeof resp.data).toBe('string');
      expect(resp.human).toBe(resp.data);
    }
  });

  it('never mints an approval card for --help on an approval-gated command', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    mockGetSession.mockReturnValue({ id: 's1', agent_group_id: 'g1', messaging_group_id: 'mg1' });

    const resp = await dispatch({ id: '1', command: 'approval-context-command', args: { help: true } }, agentCtx());

    expect(resp.ok).toBe(true);
    expect(approvalState.requestApproval).not.toHaveBeenCalled();
    expect(approvalState.observedContexts).toHaveLength(0); // handler never ran
  });

  it('renders deep verb help when the resource def is available', async () => {
    mockGetResource.mockImplementation((plural: string) =>
      plural === 'groups'
        ? {
            name: 'group',
            plural: 'groups',
            table: 'agent_groups',
            description: 'Agent groups.',
            idColumn: 'id',
            scopeField: 'id',
            columns: [],
            operations: {},
            customOperations: {
              test: {
                access: 'open',
                description: 'Deep test op.',
                args: [{ name: 'foo', type: 'string', description: 'A foo.', required: true }],
                handler: async () => ({}),
              },
            },
          }
        : undefined,
    );

    const resp = await dispatch({ id: '1', command: 'groups-test', args: { help: true } }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      expect(resp.data).toContain('ncl groups test');
      expect(resp.data).toContain('--foo');
      expect(resp.data).toContain('(required)');
    }
  });

  it('renders deep verb help for a multi-word custom-operation key (spaces vs dashes)', async () => {
    // registerResource stores the op under 'config update' but registers the
    // command as 'groups-config-update'; help must bridge the two.
    mockGetResource.mockImplementation((plural: string) =>
      plural === 'groups'
        ? {
            name: 'group',
            plural: 'groups',
            table: 'agent_groups',
            description: 'Agent groups.',
            idColumn: 'id',
            scopeField: 'id',
            columns: [],
            operations: {},
            customOperations: {
              'config update': {
                access: 'open',
                description: 'Update container config.',
                args: [{ name: 'model', type: 'string', description: 'Model override.' }],
                handler: async () => ({}),
              },
            },
          }
        : undefined,
    );

    const resp = await dispatch({ id: '1', command: 'groups-config-update', args: { help: true } }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      expect(resp.data).toContain('ncl groups config update');
      expect(resp.data).toContain('--model');
      // Not the bare registry description fallback:
      expect(resp.data).not.toBe('bare registry description (should not be the help answer)');
    }
  });

  it('still enforces group scope before answering --help', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'wirings-list', args: { help: true } }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('forbidden');
  });
});

// --- Unknown-command errors carry their fix ---

describe('unknown-command errors', () => {
  it('lists the resource verbs when the command names a known resource', async () => {
    mockGetResource.mockImplementation((plural: string) =>
      plural === 'groups'
        ? {
            name: 'group',
            plural: 'groups',
            table: 'agent_groups',
            description: 'Agent groups.',
            idColumn: 'id',
            columns: [],
            operations: { list: 'open', get: 'open' },
            customOperations: {
              restart: { access: 'approval', description: 'Restart.', handler: async () => ({}) },
            },
          }
        : undefined,
    );

    const resp = await dispatch({ id: '1', command: 'groups-restrat', args: {} }, { caller: 'host' });

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('unknown-command');
      expect(resp.error.message).toContain('verbs for groups: list, get, restart');
      expect(resp.error.message).toContain('ncl groups help');
    }
  });

  it('suggests the closest command name for near-miss typos', async () => {
    const resp = await dispatch({ id: '1', command: 'test-cm', args: {} }, { caller: 'host' });

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('unknown-command');
      expect(resp.error.message).toContain('did you mean "test-cmd"?');
    }
  });

  it('falls back to a plain pointer when nothing is close', async () => {
    const resp = await dispatch({ id: '1', command: 'zzz-qqq-vvv', args: {} }, { caller: 'host' });

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.message).toContain('no command "zzz-qqq-vvv"');
      expect(resp.error.message).toContain('ncl help');
      expect(resp.error.message).not.toContain('did you mean');
    }
  });
});

// --- formatHuman hook: server-rendered human view on the frame ---

describe('formatHuman hook', () => {
  register({
    name: 'render-cmd',
    description: 'command with a human renderer',
    access: 'open',
    parseArgs: (raw) => raw,
    handler: async () => [{ id: 'x1', status: 'live' }],
    formatHuman: (rows) => `TABLE(${(rows as { id: string }[]).map((r) => r.id).join(',')})`,
  });

  register({
    name: 'render-throws',
    description: 'command whose renderer throws',
    access: 'open',
    parseArgs: (raw) => raw,
    handler: async () => ({ fine: true }),
    formatHuman: () => {
      throw new Error('renderer bug');
    },
  });

  it('attaches human alongside data', async () => {
    const resp = await dispatch({ id: '1', command: 'render-cmd', args: {} }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      expect(resp.human).toBe('TABLE(x1)');
      expect(resp.data).toEqual([{ id: 'x1', status: 'live' }]); // machine contract intact
    }
  });

  it('a throwing renderer degrades to a plain frame, never an error', async () => {
    const resp = await dispatch({ id: '1', command: 'render-throws', args: {} }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      expect(resp.human).toBeUndefined();
      expect(resp.data).toEqual({ fine: true });
    }
  });

  it('commands without a renderer stay human-less', async () => {
    const resp = await dispatch({ id: '1', command: 'test-cmd', args: {} }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    if (resp.ok) expect(resp.human).toBeUndefined();
  });
});
