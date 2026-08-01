/**
 * Tests for requestApproval's approver selection + fail-safety, focused on the
 * privilege-proportional `approverConstraint` path (role changes) alongside the
 * legacy any-eligible-admin path (create_agent, install_packages, OneCLI …).
 *
 * The DB / delivery / session-manager deps are mocked so we can assert exactly
 * who the card is pinned + delivered to, and that no card goes out when no
 * qualified, non-conflicted, reachable approver exists.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session, UserRole } from '../../types.js';

vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const roleRows = vi.hoisted(() => ({
  owners: [] as UserRole[],
  globalAdmins: [] as UserRole[],
  scopedAdmins: new Map<string, UserRole[]>(),
}));
vi.mock('../permissions/db/user-roles.js', () => ({
  getOwners: () => roleRows.owners,
  getGlobalAdmins: () => roleRows.globalAdmins,
  getAdminsOfAgentGroup: (agentGroupId: string) => roleRows.scopedAdmins.get(agentGroupId) ?? [],
}));

// Reachability: any user whose id is in `reachable` resolves to a DM.
const reachable = vi.hoisted(() => new Set<string>());
vi.mock('../permissions/user-dm.js', () => ({
  ensureUserDm: async (userId: string) =>
    reachable.has(userId)
      ? { id: `mg-${userId}`, channel_type: userId.split(':')[0], platform_id: userId.split(':')[1] }
      : null,
}));

vi.mock('../../db/messaging-groups.js', () => ({
  getMessagingGroup: (_id: string) => ({ channel_type: 'telegram', platform_id: 'origin' }),
}));

const createdApprovals = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../../db/sessions.js', () => ({
  createPendingApproval: (row: Record<string, unknown>) => createdApprovals.push(row),
  getSession: (_id: string) => null,
}));

const delivered = vi.hoisted(() => [] as Array<{ channelType: string; platformId: string }>);
vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: () => ({
    deliver: async (channelType: string, platformId: string) => {
      delivered.push({ channelType, platformId });
      return undefined;
    },
  }),
}));

const notices = vi.hoisted(() => [] as string[]);
vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: (_g: string, _s: string, msg: { content: string }) => {
    notices.push(JSON.parse(msg.content).text as string);
  },
}));
vi.mock('../../container-runner.js', () => ({ wakeContainer: async () => undefined }));

import { requestApproval } from './primitive.js';

const session: Session = {
  id: 's1',
  agent_group_id: 'ag-1',
  messaging_group_id: 'mg-origin',
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'running',
  last_active: null,
  created_at: '2020-01-01',
};

beforeEach(() => {
  roleRows.owners = [];
  roleRows.globalAdmins = [];
  roleRows.scopedAdmins = new Map();
  reachable.clear();
  createdApprovals.length = 0;
  delivered.length = 0;
  notices.length = 0;
});

function base() {
  return {
    session,
    agentName: 'Agent',
    action: 'cli_command',
    payload: { frame: {} },
    title: 't',
    question: 'q',
  };
}

describe('requestApproval — constrained (privilege-proportional) routing', () => {
  it('pins + delivers to an owner (highest privilege), never the group admin, for an owner-level change', async () => {
    roleRows.owners = [
      { user_id: 'telegram:owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: '2020-01-01' },
    ];
    roleRows.globalAdmins = [
      { user_id: 'telegram:ga', role: 'admin', agent_group_id: null, granted_by: null, granted_at: '2020-01-01' },
    ];
    roleRows.scopedAdmins.set('ag-1', [
      { user_id: 'telegram:sa', role: 'admin', agent_group_id: 'ag-1', granted_by: null, granted_at: '2020-01-01' },
    ]);
    reachable.add('telegram:owner');
    reachable.add('telegram:ga');
    reachable.add('telegram:sa');

    await requestApproval({ ...base(), approverConstraint: { minLevel: 'owner' } });

    expect(createdApprovals).toHaveLength(1);
    expect(createdApprovals[0].approver_user_id).toBe('telegram:owner');
    expect(delivered).toEqual([{ channelType: 'telegram', platformId: 'owner' }]);
  });

  it('excludes the target of the change — no self-approval', async () => {
    roleRows.owners = [
      { user_id: 'telegram:owner1', role: 'owner', agent_group_id: null, granted_by: null, granted_at: '2020-01-01' },
      { user_id: 'telegram:owner2', role: 'owner', agent_group_id: null, granted_by: null, granted_at: '2020-01-02' },
    ];
    reachable.add('telegram:owner1');
    reachable.add('telegram:owner2');

    // owner1 is the target of the revoke → must route to owner2.
    await requestApproval({
      ...base(),
      approverConstraint: { minLevel: 'owner', excludeUserIds: ['telegram:owner1'] },
    });

    expect(createdApprovals[0].approver_user_id).toBe('telegram:owner2');
    expect(delivered).toEqual([{ channelType: 'telegram', platformId: 'owner2' }]);
  });

  it('HOLDs with a message when the only qualified approver is the target (no downward/target fallback)', async () => {
    roleRows.owners = [
      { user_id: 'telegram:owner1', role: 'owner', agent_group_id: null, granted_by: null, granted_at: '2020-01-01' },
    ];
    roleRows.globalAdmins = [
      { user_id: 'telegram:ga', role: 'admin', agent_group_id: null, granted_by: null, granted_at: '2020-01-01' },
    ];
    reachable.add('telegram:owner1');
    reachable.add('telegram:ga');

    await requestApproval({
      ...base(),
      approverConstraint: { minLevel: 'owner', excludeUserIds: ['telegram:owner1'] },
    });

    expect(createdApprovals).toHaveLength(0);
    expect(delivered).toHaveLength(0);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('no sufficiently-privileged approver');
  });

  it('HOLDs when a qualified approver exists but is unreachable (never falls to a junior)', async () => {
    roleRows.owners = [
      { user_id: 'telegram:owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: '2020-01-01' },
    ];
    roleRows.globalAdmins = [
      { user_id: 'telegram:ga', role: 'admin', agent_group_id: null, granted_by: null, granted_at: '2020-01-01' },
    ];
    reachable.add('telegram:ga'); // owner not reachable; ga must NOT be used for an owner-level change

    await requestApproval({ ...base(), approverConstraint: { minLevel: 'owner' } });

    expect(createdApprovals).toHaveLength(0);
    expect(delivered).toHaveLength(0);
    expect(notices[0]).toContain('no sufficiently-privileged approver is reachable');
  });

  it('global-admin level: a global admin may approve a group-scoped admin change', async () => {
    roleRows.globalAdmins = [
      { user_id: 'telegram:ga', role: 'admin', agent_group_id: null, granted_by: null, granted_at: '2020-01-01' },
    ];
    roleRows.scopedAdmins.set('ag-1', [
      { user_id: 'telegram:sa', role: 'admin', agent_group_id: 'ag-1', granted_by: null, granted_at: '2020-01-01' },
    ]);
    reachable.add('telegram:ga');
    reachable.add('telegram:sa');

    await requestApproval({
      ...base(),
      approverConstraint: { minLevel: 'global-admin', excludeUserIds: ['telegram:sa'] },
    });

    expect(createdApprovals[0].approver_user_id).toBe('telegram:ga');
  });
});

describe('requestApproval — legacy (unconstrained) routing unchanged', () => {
  it('non-role approval uses pickApprover order (scoped admin first) and does NOT pin approver_user_id', async () => {
    roleRows.owners = [
      { user_id: 'telegram:owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: '2020-01-01' },
    ];
    roleRows.scopedAdmins.set('ag-1', [
      { user_id: 'telegram:sa', role: 'admin', agent_group_id: 'ag-1', granted_by: null, granted_at: '2020-01-01' },
    ]);
    reachable.add('telegram:owner');
    reachable.add('telegram:sa');

    await requestApproval({ ...base() });

    // legacy ordering delivers to the scoped admin first; approver_user_id stays null.
    expect(delivered).toEqual([{ channelType: 'telegram', platformId: 'sa' }]);
    expect(createdApprovals[0].approver_user_id).toBeNull();
  });

  it('explicit approverUserId still pins that exact user', async () => {
    reachable.add('telegram:someone');
    await requestApproval({ ...base(), approverUserId: 'telegram:someone' });
    expect(createdApprovals[0].approver_user_id).toBe('telegram:someone');
  });
});
