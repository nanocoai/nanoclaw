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
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PendingApproval, Session } from '../../types.js';

// The folder-dedupe loop is disk-aware (A4): point GROUPS_DIR at a temp root
// so the residue-skip test controls what is on disk. Absent for every other
// test, so their behavior is unchanged.
const A2A_TEST_ROOT = '/tmp/nanoclaw-test-a2a-create-agent';
vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-test-a2a-create-agent/groups',
}));

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
  mockEnsureTemplateLocal,
  mockCreateAgentFromTemplate,
  existingDestinations,
  liveApprovals,
  approvalHandlers,
} = vi.hoisted(() => ({
  mockRequestApproval: vi.fn().mockResolvedValue(undefined),
  mockGetContainerConfig: vi.fn(),
  mockCreateAgentGroup: vi.fn(),
  mockInitGroupFilesystem: vi.fn(),
  mockWriteDestinations: vi.fn(),
  mockNotifyWrite: vi.fn(),
  mockEnsureTemplateLocal: vi.fn(),
  mockCreateAgentFromTemplate: vi.fn(),
  existingDestinations: new Set<string>(),
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
  getDestinationByName: (group: string, name: string) =>
    existingDestinations.has(`${group}/${name}`) ? { target_type: 'agent', target_id: 'ag-existing' } : undefined,
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
}));
// The template library and stamper have their own tests; here they are the
// seams the template branch must call in the right order.
vi.mock('../../templates/library.js', () => ({
  ensureTemplateLocal: (...a: unknown[]) => mockEnsureTemplateLocal(...a),
  hasLocalTemplate: (ref: string) => ref === 'local/one',
}));
vi.mock('../../templates/create-agent.js', async (importOriginal) => ({
  templateFolder: (await importOriginal<typeof import('../../templates/create-agent.js')>()).templateFolder,
  createAgentFromTemplate: (...a: unknown[]) => mockCreateAgentFromTemplate(...a),
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
  await wrapped!(content, SESSION);
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
  mockEnsureTemplateLocal.mockResolvedValue({ dir: '/tmp/templates/sales/sdr', fetched: true, commit: 'c0ffee' });
  mockCreateAgentFromTemplate.mockResolvedValue({ group: { id: 'ag-sdr', name: 'SDR', folder: 'sdr' }, report: [] });
});

function notifyTexts(): string[] {
  return mockNotifyWrite.mock.calls.map((c) => JSON.parse((c[2] as { content: string }).content).text as string);
}

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

  it('quotes the requested agent name in the card title and question', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    await runCreateAgent({ name: 'Scout\nApproved', instructions: 'help' });

    const opts = mockRequestApproval.mock.calls[0][0] as { title: string; question: string };
    expect(opts.title).toBe('Create agent: "Scout\\nApproved"');
    expect(opts.question).toContain('sub-agent "Scout\\nApproved"');
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

  it('skips deleted-group residue on disk when minting the folder (A4)', async () => {
    // groups/scout exists on disk but no DB row claims it (the mocked
    // getAgentGroupByFolder always returns undefined) — exactly the state
    // `ncl groups delete` leaves behind. The dedupe loop must treat disk
    // presence as taken and mint scout-2, never adopt the residue.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });
    fs.mkdirSync(path.join(A2A_TEST_ROOT, 'groups', 'scout'), { recursive: true });
    try {
      await runCreateAgent({ name: 'Scout', instructions: 'help' });

      expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
      expect(mockCreateAgentGroup.mock.calls[0][0]).toMatchObject({ folder: 'scout-2' });
    } finally {
      fs.rmSync(A2A_TEST_ROOT, { recursive: true, force: true });
    }
  });
});

// What the name alone decides is refused before the hold, so no admin is carded for it.
describe.each(['global', 'group'])(
  'create_agent — a name whose folder cannot be a group folder is refused (%s scope)',
  (scope) => {
    beforeEach(() => {
      mockGetContainerConfig.mockReturnValue({ cli_scope: scope });
    });
    afterEach(() => {
      fs.rmSync(A2A_TEST_ROOT, { recursive: true, force: true });
    });

    function expectRefusedWithNothingCreated(folder: string, why: string): void {
      expect(mockRequestApproval).not.toHaveBeenCalled();
      expect(mockEnsureTemplateLocal).not.toHaveBeenCalled();
      expect(mockCreateAgentGroup).not.toHaveBeenCalled();
      expect(mockCreateAgentFromTemplate).not.toHaveBeenCalled();
      expect(mockInitGroupFilesystem).not.toHaveBeenCalled();
      expect(mockWriteDestinations).not.toHaveBeenCalled();
      const text = notifyTexts().at(-1);
      expect(text).toContain(`Invalid group folder "${folder}" — ${why}.`);
      expect(text).toMatch(/^Cannot create agent ".+Nothing was created\.$/);
    }

    it('a longer name than the limit', async () => {
      const name = 'a'.repeat(70);

      await runCreateAgent({ name });

      expectRefusedWithNothingCreated(name, 'too long: 70 characters, at most 63');
    });

    // A v1 migration copies groups/global onto disk; the refusal must not depend on it.
    it.each([
      ['a fresh install', false],
      ['an install migrated from v1 (groups/global on disk)', true],
    ])('"Global", as reserved, on %s', async (_install, migrated) => {
      if (migrated) fs.mkdirSync(path.join(A2A_TEST_ROOT, 'groups', 'global'), { recursive: true });

      await runCreateAgent({ name: 'Global' });

      expectRefusedWithNothingCreated('global', 'reserved');
    });

    it('a template create with a longer name, before the template is fetched', async () => {
      const name = 'c'.repeat(70);

      await runCreateAgent({ name, template: 'sales/sdr' });

      expectRefusedWithNothingCreated(name, 'too long: 70 characters, at most 63');
    });
  },
);

// Whether another group holds a folder is not a confined agent's to learn, so a clash whose suffix
// overflows is found only after authorization: on the approved replay, or directly in global scope.
describe('create_agent — a taken folder is found after authorization', () => {
  afterEach(() => {
    fs.rmSync(A2A_TEST_ROOT, { recursive: true, force: true });
  });

  async function approve(payload: Record<string, unknown>): Promise<void> {
    await approvalHandlers.get('create_agent')!({
      session: SESSION,
      payload,
      approval: liveGrant('appr-ca-taken', payload),
      userId: 'telegram:admin',
      notify: vi.fn(),
    });
  }

  // At these lengths the suffix overflows: -2 on a plain create, -<8 hex> on a template one.
  it.each([
    ['plain', 62, {}],
    ['template', 55, { template: 'sales/sdr' }],
  ])('group scope (%s): a taken and a free name get the same card', async (_kind, length, extra) => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    const name = 'b'.repeat(length);
    await runCreateAgent({ name, ...extra });
    fs.mkdirSync(path.join(A2A_TEST_ROOT, 'groups', name), { recursive: true });
    await runCreateAgent({ name, ...extra });

    expect(mockRequestApproval).toHaveBeenCalledTimes(2);
    expect(notifyTexts()).toEqual([]);
  });

  it('group scope: the approved replay refuses the overflowing suffix, saying the name is taken', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    const name = 'b'.repeat(62);
    fs.mkdirSync(path.join(A2A_TEST_ROOT, 'groups', name), { recursive: true });

    await runCreateAgent({ name });
    await approve({ name, instructions: null });

    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(notifyTexts()).toEqual([
      `Cannot create agent "${name}": Invalid group folder "${name}-2" — too long: 64 characters, at most 63 ("${name}" is already taken). Nothing was created.`,
    ]);
  });

  // The template stamp adds -<8 hex> on a clash, so 54 characters is the most that still fits.
  it('group scope: the approved replay refuses a template clash before the template is fetched', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    const name = 'd'.repeat(55);
    fs.mkdirSync(path.join(A2A_TEST_ROOT, 'groups', name), { recursive: true });

    await runCreateAgent({ name, template: 'sales/sdr' });
    await approve({ name, instructions: null, template: 'sales/sdr' });

    expect(mockEnsureTemplateLocal).not.toHaveBeenCalled();
    expect(mockCreateAgentFromTemplate).not.toHaveBeenCalled();
    expect(notifyTexts().at(-1)).toMatch(
      new RegExp(`too long: 64 characters, at most 63 \\("${name}" is already taken\\)\\. Nothing was created\\.$`),
    );
  });

  it('global scope: refused at once, saying the name is taken', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });
    const name = 'b'.repeat(62);
    fs.mkdirSync(path.join(A2A_TEST_ROOT, 'groups', name), { recursive: true });

    await runCreateAgent({ name });

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(notifyTexts().at(-1)).toContain(`("${name}" is already taken). Nothing was created.`);
  });
});

// An install migrated from v1 can hold an agent "Global" under global-2; asking for it again must
// reach the create (its collision answer, or a wrapper's resume), not the folder refusal.
describe('create_agent — a name the requester already has', () => {
  beforeEach(() => {
    existingDestinations.add('ag-1/global');
  });
  afterEach(() => {
    existingDestinations.clear();
  });

  it('gets the collision answer, not the folder reason (global scope)', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await runCreateAgent({ name: 'Global' });

    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(notifyTexts()).toEqual(['Cannot create agent "Global": you already have a destination named "global".']);
  });

  it('is held for the admin as before (group scope)', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    await runCreateAgent({ name: 'Global' });

    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    expect(notifyTexts()).toEqual([]);
  });
});

describe('create_agent — the folder limit', () => {
  it('a name at the limit is created', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });
    const name = 'a'.repeat(63);

    await runCreateAgent({ name });

    expect(mockCreateAgentGroup.mock.calls[0][0]).toMatchObject({ folder: name });
  });

  it('a name taken between the card and the approval is refused on the approved replay', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    const name = 'e'.repeat(62);
    await runCreateAgent({ name });
    expect(mockRequestApproval).toHaveBeenCalledTimes(1);

    fs.mkdirSync(path.join(A2A_TEST_ROOT, 'groups', name), { recursive: true });
    try {
      const payload = { name, instructions: null };
      await approvalHandlers.get('create_agent')!({
        session: SESSION,
        payload,
        approval: liveGrant('appr-ca-race', payload),
        userId: 'telegram:admin',
        notify: vi.fn(),
      });

      expect(mockCreateAgentGroup).not.toHaveBeenCalled();
      expect(mockRequestApproval).toHaveBeenCalledTimes(1);
      expect(notifyTexts().at(-1)).toContain(`("${name}" is already taken). Nothing was created.`);
    } finally {
      fs.rmSync(A2A_TEST_ROOT, { recursive: true, force: true });
    }
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

describe('create_agent — from a template', () => {
  it('global scope: fetches, stamps with the agent name and parent provider, wires, and says which template', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global', provider: 'codex' });

    await runCreateAgent({ name: 'SDR', instructions: 'ignored', template: 'sales/sdr' });

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockEnsureTemplateLocal).toHaveBeenCalledWith('sales/sdr');
    expect(mockCreateAgentFromTemplate).toHaveBeenCalledWith('sales/sdr', { name: 'SDR', provider: 'codex' });
    expect(mockEnsureTemplateLocal.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateAgentFromTemplate.mock.invocationCallOrder[0],
    );
    expect(mockInitGroupFilesystem).not.toHaveBeenCalled();
    expect(mockWriteDestinations).toHaveBeenCalledWith('ag-1', 'sess-1');
    expect(notifyTexts().at(-1)).toContain('Agent "sdr" created from template "sales/sdr"');
  });

  it('a failed download creates nothing and says so', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });
    mockEnsureTemplateLocal.mockRejectedValue(new Error('Could not clone the template library'));

    await runCreateAgent({ name: 'SDR', template: 'sales/sdr' });

    expect(mockCreateAgentFromTemplate).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(notifyTexts().at(-1)).toContain('Could not clone the template library. Nothing was created.');
  });

  it('a malformed ref is answered before any approval is asked for', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    await runCreateAgent({ name: 'SDR', template: '../../etc' });

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockEnsureTemplateLocal).not.toHaveBeenCalled();
    expect(notifyTexts().at(-1)).toContain('is not a template ref');
  });

  it('group scope: the hold stores the template, no instructions, and the card says where it comes from', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    await runCreateAgent({ name: 'SDR', instructions: 'ignored', template: 'sales/sdr' });
    await runCreateAgent({ name: 'Ops', template: 'local/one' });

    expect(mockEnsureTemplateLocal).not.toHaveBeenCalled(); // nothing is downloaded before approval
    const [library, local] = mockRequestApproval.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(library.payload).toEqual({ name: 'SDR', instructions: null, template: 'sales/sdr' });
    expect(library.question).toContain('template "sales/sdr" (downloaded from the public template library)');
    expect(local.question).toContain('template "local/one" (already on this machine)');
  });

  it('approving the stored hold builds the agent from that template', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    await runCreateAgent({ name: 'SDR', instructions: 'ignored', template: 'sales/sdr' });
    // The replay runs with the stored payload, as the approvals response handler does.
    const stored = (mockRequestApproval.mock.calls[0][0] as { payload: Record<string, unknown> }).payload;
    const approval = liveGrant('appr-tpl-1', stored);

    await approvalHandlers.get('create_agent')!({
      session: SESSION,
      payload: JSON.parse(approval.payload),
      approval,
      userId: 'telegram:admin',
      notify: vi.fn(),
    });

    expect(mockCreateAgentFromTemplate).toHaveBeenCalledWith('sales/sdr', { name: 'SDR', provider: 'claude' });
  });

  it('an approval for a plain create never covers a templated request', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    const plain = liveGrant('appr-tpl-2', { name: 'SDR', instructions: null });

    await approvalHandlers.get('create_agent')!({
      session: SESSION,
      payload: { name: 'SDR', instructions: null, template: 'sales/sdr' },
      approval: plain,
      userId: 'telegram:admin',
      notify: vi.fn(),
    });

    expect(mockCreateAgentFromTemplate).not.toHaveBeenCalled();
  });
});
