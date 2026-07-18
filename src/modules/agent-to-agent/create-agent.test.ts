/**
 * Tests for create_agent host-side authorization.
 *
 * Regression guard for the audit finding: `create_agent` is a privileged
 * central-DB write with no host-side authz. Authorization is the guard's
 * `agents.create` decision — trusted owner agent groups ('global') create
 * directly; confined groups ('group', the default and the prompt-injection
 * victim) hold for admin approval. These tests drive the REAL wrapped
 * delivery action (the only reachable path) and the approve continuation's
 * grant-carrying re-entry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PendingApproval, Session } from '../../types.js';

// Mocks for the collaborators the branch decides between / depends on.
// vi.hoisted: the module barrel import below runs before this file's const
// initializers, and the mock factories close over this state.
const {
  mockRequestApproval,
  mockGetContainerConfig,
  mockCreateAgentGroup,
  mockInitGroupFilesystem,
  mockWriteDestinations,
  mockNotifyWrite,
  liveApprovals,
  approvalHandlers,
} = vi.hoisted(() => ({
  mockRequestApproval: vi.fn().mockResolvedValue(undefined),
  mockGetContainerConfig: vi.fn(),
  mockCreateAgentGroup: vi.fn(),
  mockInitGroupFilesystem: vi.fn(),
  mockWriteDestinations: vi.fn(),
  mockNotifyWrite: vi.fn(),
  liveApprovals: new Map<string, import('../../types.js').PendingApproval>(),
  approvalHandlers: new Map<string, (ctx: Record<string, unknown>) => Promise<void>>(),
}));

vi.mock('../approvals/index.js', () => ({
  requestApproval: (...a: unknown[]) => mockRequestApproval(...a),
  notifyAgent: vi.fn(),
  registerApprovalHandler: (action: string, handler: (ctx: Record<string, unknown>) => Promise<void>) => {
    approvalHandlers.set(action, handler);
  },
}));
vi.mock('../../db/container-configs.js', () => ({
  getContainerConfig: (...a: unknown[]) => mockGetContainerConfig(...a),
  ensureContainerConfig: () => {},
}));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: (id: string) => ({ id, name: id.toUpperCase(), folder: id, agent_provider: null, created_at: '' }),
  getAgentGroupByFolder: () => undefined,
  createAgentGroup: (...a: unknown[]) => mockCreateAgentGroup(...a),
}));
vi.mock('../../group-init.js', () => ({
  initGroupFilesystem: (...a: unknown[]) => mockInitGroupFilesystem(...a),
}));
vi.mock('./write-destinations.js', () => ({
  writeDestinations: (...a: unknown[]) => mockWriteDestinations(...a),
}));
vi.mock('./db/agent-destinations.js', () => ({
  getDestinationByName: () => undefined,
  createDestination: vi.fn(),
  hasDestination: () => true,
  normalizeName: (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
}));
// notifyAgent writes to the session inbound.db + wakes the container; stub both.
// delivery.ts and agent-route.ts pull more session-manager exports at import time.
vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: (...a: unknown[]) => mockNotifyWrite(...a),
  openInboundDb: vi.fn(),
  openOutboundDb: vi.fn(),
  clearOutbox: vi.fn(),
  readOutboxFiles: vi.fn().mockReturnValue([]),
  resolveSession: vi.fn(),
  sessionDir: vi.fn().mockReturnValue('/tmp/nowhere'),
  inboundDbPath: vi.fn().mockReturnValue('/tmp/nowhere/inbound.db'),
}));
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../db/sessions.js', () => ({
  getSession: (id: string) => ({ id, agent_group_id: 'ag-1' }),
  getPendingApproval: (id: string) => liveApprovals.get(id),
  getRunningSessions: () => [],
  getActiveSessions: () => [],
  createPendingQuestion: vi.fn(),
}));

// The a2a module barrel registers ./guard.js (catalog entries) and the
// guard-wrapped create_agent delivery action — the path under test.
import './index.js';
import { getDeliveryAction } from '../../delivery.js';

const SESSION = { id: 'sess-1', agent_group_id: 'ag-1' } as Session;

async function runCreateAgent(content: Record<string, unknown>): Promise<void> {
  const wrapped = getDeliveryAction('create_agent');
  expect(wrapped).toBeDefined();
  await wrapped!(content, SESSION, undefined as never);
}

function liveGrant(approvalId: string, payload: Record<string, unknown>): PendingApproval {
  const row = {
    approval_id: approvalId,
    session_id: SESSION.id,
    request_id: approvalId,
    action: 'create_agent',
    payload: JSON.stringify(payload),
    created_at: new Date().toISOString(),
    agent_group_id: 'ag-1',
    channel_type: null,
    platform_id: null,
    platform_message_id: null,
    expires_at: null,
    status: 'pending',
    title: '',
    options_json: '[]',
    approver_user_id: null,
  } as PendingApproval;
  liveApprovals.set(approvalId, row);
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  liveApprovals.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('create_agent — guard-based authorization (wrapped delivery action)', () => {
  it('global scope: creates directly, no approval requested', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await runCreateAgent({ name: 'Scout', instructions: 'help' });

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
    expect(mockInitGroupFilesystem).toHaveBeenCalledTimes(1);
  });

  it('child inherits the creator provider (codex parent → codex child)', async () => {
    // A subagent must run on the same authenticated runtime as its creator —
    // on a codex-only install a claude default would 401. The provider is
    // passed to initGroupFilesystem, which stamps the child's config row.
    // Red-on-delete: dropping the inheritance lets the child fall through to the
    // instance default instead of codex.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global', provider: 'codex' });

    await runCreateAgent({ name: 'Scout', instructions: 'help' });

    expect(mockInitGroupFilesystem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ provider: 'codex' }),
    );
  });

  it('claude creator pins the child to claude, not the instance default', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' }); // parent has no explicit provider

    await runCreateAgent({ name: 'Scout', instructions: 'help' });

    // The child inherits the parent's EFFECTIVE provider (claude), passed
    // explicitly so it never falls through to a non-claude instance default.
    expect(mockInitGroupFilesystem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ provider: 'claude' }),
    );
  });

  it('group scope (default): requires approval, does NOT create directly', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    await runCreateAgent({ name: 'Scout', instructions: 'help' });

    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    expect(mockRequestApproval.mock.calls[0][0]).toMatchObject({ action: 'create_agent' });
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(mockInitGroupFilesystem).not.toHaveBeenCalled();
  });

  it('missing config: fails closed to approval (no direct create)', async () => {
    mockGetContainerConfig.mockReturnValue(undefined);

    await runCreateAgent({ name: 'Scout' });

    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });

  it('disabled/other scope: requires approval', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'disabled' });

    await runCreateAgent({ name: 'Scout' });

    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });

  it('empty name: neither creates nor requests approval', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await runCreateAgent({ name: '' });

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });
});

describe('create_agent — approved replay (grant-carrying re-entry)', () => {
  it('valid grant executes exactly once — decide hold is satisfied, create runs', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    const payload = { name: 'Scout', instructions: 'help' };
    const approval = liveGrant('appr-ca-1', payload);

    const continuation = approvalHandlers.get('create_agent');
    expect(continuation).toBeDefined();
    await continuation!({ session: SESSION, payload, approval, userId: 'telegram:admin', notify: vi.fn() });

    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
    expect(mockRequestApproval).not.toHaveBeenCalled(); // no second card
  });

  it('dead grant (row already resolved) refuses the replay', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    const payload = { name: 'Scout', instructions: 'help' };
    const approval = liveGrant('appr-ca-2', payload);
    liveApprovals.delete('appr-ca-2'); // resolution consumed the row

    await approvalHandlers.get('create_agent')!({
      session: SESSION,
      payload,
      approval,
      userId: 'telegram:admin',
      notify: vi.fn(),
    });

    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(mockRequestApproval).not.toHaveBeenCalled(); // refused, not re-held
  });

  it('mismatched grant (approved for a different name) refuses the replay', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    const approval = liveGrant('appr-ca-3', { name: 'OtherAgent' });

    await approvalHandlers.get('create_agent')!({
      session: SESSION,
      payload: { name: 'Scout' },
      approval,
      userId: 'telegram:admin',
      notify: vi.fn(),
    });

    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(mockRequestApproval).not.toHaveBeenCalled();
  });
});
