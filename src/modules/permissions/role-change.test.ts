import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { UserRole } from '../../types.js';

// --- Mocks (DB accessors the summary reads) ---

const mockGetAgentGroup = vi.fn();
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: (...args: unknown[]) => mockGetAgentGroup(...args),
}));

const mockGetUserRoles = vi.fn();
vi.mock('./db/user-roles.js', () => ({
  getUserRoles: (...args: unknown[]) => mockGetUserRoles(...args),
}));

const mockGetUser = vi.fn();
vi.mock('./db/users.js', () => ({
  getUser: (...args: unknown[]) => mockGetUser(...args),
}));

import { describeRoleChange, renderRoleChangeCard, ROLE_CHANGE_COMMANDS } from './role-change.js';

const ORIGIN = {
  agentName: 'corp-bot',
  channel: 'slack (T01/C99)',
  commandLine: 'ncl roles-grant --user slack:U0123 --role admin',
};

function role(partial: Partial<UserRole>): UserRole {
  return {
    user_id: 'slack:U0123',
    role: 'admin',
    agent_group_id: null,
    granted_by: null,
    granted_at: '2026-01-01',
    ...partial,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockReturnValue(undefined);
  mockGetUserRoles.mockReturnValue([]);
  mockGetAgentGroup.mockReturnValue(undefined);
});

describe('describeRoleChange', () => {
  it('exposes the role-change command names for routing reuse', () => {
    expect(ROLE_CHANGE_COMMANDS.has('roles-grant')).toBe(true);
    expect(ROLE_CHANGE_COMMANDS.has('roles-revoke')).toBe(true);
    expect(ROLE_CHANGE_COMMANDS.has('groups-list')).toBe(false);
  });

  it('resolves the target handle to a display name', () => {
    mockGetUser.mockReturnValue({ id: 'slack:U0123', display_name: 'Jane Doe' });
    const s = describeRoleChange('grant', { user: 'slack:U0123', role: 'admin' });
    expect(s.targetUserId).toBe('slack:U0123');
    expect(s.targetDisplay).toBe('Jane Doe');
  });

  it('leaves display null when the user is unknown', () => {
    const s = describeRoleChange('grant', { user: 'slack:U0123', role: 'admin' });
    expect(s.targetDisplay).toBeNull();
  });

  it('a scoped admin grant is a group scope with resolved group name', () => {
    mockGetAgentGroup.mockReturnValue({ id: 'g-sales', name: 'sales-team' });
    const s = describeRoleChange('grant', { user: 'slack:U0123', role: 'admin', group: 'g-sales' });
    expect(s.scope).toEqual({ kind: 'group', groupId: 'g-sales', groupName: 'sales-team' });
    expect(s.capabilities).toContain('this agent group');
  });

  it('a global admin grant (no --group) is global scope', () => {
    const s = describeRoleChange('grant', { user: 'slack:U0123', role: 'admin' });
    expect(s.scope.kind).toBe('global');
    expect(s.capabilities).toContain('all agent groups');
  });

  it('owner is always global even when --group is passed', () => {
    const s = describeRoleChange('grant', { user: 'slack:U0123', role: 'owner', group: 'g-sales' });
    expect(s.scope).toEqual({ kind: 'global', groupId: null, groupName: null });
    expect(s.capabilities).toContain('full control');
  });

  it('computes before/after for a grant that adds a new scoped role', () => {
    mockGetAgentGroup.mockImplementation((id: string) =>
      id === 'g-mkt' ? { id, name: 'marketing' } : { id, name: 'sales-team' },
    );
    mockGetUserRoles.mockReturnValue([role({ role: 'admin', agent_group_id: 'g-mkt' })]);
    const s = describeRoleChange('grant', { user: 'slack:U0123', role: 'admin', group: 'g-sales' });
    expect(s.before).toHaveLength(1);
    expect(s.after).toHaveLength(2);
    expect(s.noop).toBe(false);
  });

  it('flags a grant of an already-held role as a no-op with unchanged after', () => {
    mockGetUserRoles.mockReturnValue([role({ role: 'admin', agent_group_id: null })]);
    const s = describeRoleChange('grant', { user: 'slack:U0123', role: 'admin' });
    expect(s.noop).toBe(true);
    expect(s.after).toHaveLength(1);
  });

  it('computes before/after for a revoke that removes the matching role', () => {
    mockGetUserRoles.mockReturnValue([
      role({ role: 'admin', agent_group_id: 'g-sales' }),
      role({ role: 'admin', agent_group_id: null }),
    ]);
    const s = describeRoleChange('revoke', { user: 'slack:U0123', role: 'admin', group: 'g-sales' });
    expect(s.before).toHaveLength(2);
    expect(s.after).toHaveLength(1);
    expect(s.after[0].scope.kind).toBe('global');
    expect(s.noop).toBe(false);
  });

  it('flags a revoke of a role the user does not hold as a no-op', () => {
    mockGetUserRoles.mockReturnValue([]);
    const s = describeRoleChange('revoke', { user: 'slack:U0123', role: 'admin', group: 'g-sales' });
    expect(s.noop).toBe(true);
    expect(s.after).toHaveLength(0);
  });

  it('accepts hyphenated arg keys', () => {
    const s = describeRoleChange('grant', { user: 'slack:U0123', role: 'admin', 'granted-by': 'slack:U9' });
    expect(s.targetUserId).toBe('slack:U0123');
  });
});

describe('renderRoleChangeCard', () => {
  it('titles by op and role, not the raw command', () => {
    const s = describeRoleChange('grant', { user: 'slack:U0123', role: 'admin' });
    const { title, question } = renderRoleChangeCard(s, ORIGIN);
    expect(title).toBe('Role grant: admin');
    expect(question).not.toMatch(/^CLI:/);
  });

  it('shows WHO with display name and handle, WHAT, and origin', () => {
    mockGetUser.mockReturnValue({ id: 'slack:U0123', display_name: 'Jane Doe' });
    mockGetAgentGroup.mockReturnValue({ id: 'g-sales', name: 'sales-team' });
    const s = describeRoleChange('grant', { user: 'slack:U0123', role: 'admin', group: 'g-sales' });
    const { question } = renderRoleChangeCard(s, ORIGIN);
    expect(question).toContain('Jane Doe (`slack:U0123`)');
    expect(question).toContain('*Action:* Grant `admin` role');
    expect(question).toContain('agent group "sales-team" (`g-sales`)');
    expect(question).toContain('*Origin:* agent "corp-bot", channel slack (T01/C99)');
  });

  it('renders before -> after state lines', () => {
    mockGetAgentGroup.mockImplementation((id: string) =>
      id === 'g-mkt' ? { id, name: 'marketing' } : { id, name: 'sales-team' },
    );
    mockGetUserRoles.mockReturnValue([role({ role: 'admin', agent_group_id: 'g-mkt' })]);
    const s = describeRoleChange('grant', { user: 'slack:U0123', role: 'admin', group: 'g-sales' });
    const { question } = renderRoleChangeCard(s, ORIGIN);
    expect(question).toContain('*Current roles:* admin @ "marketing"');
    expect(question).toContain('*After approval:* admin @ "marketing", admin @ "sales-team"');
  });

  it('says (none) when the target currently holds no roles', () => {
    const s = describeRoleChange('grant', { user: 'slack:U0123', role: 'admin' });
    const { question } = renderRoleChangeCard(s, ORIGIN);
    expect(question).toContain('*Current roles:* (none)');
    expect(question).toContain('*After approval:* admin (global)');
  });

  it('surfaces a no-op grant note', () => {
    mockGetUserRoles.mockReturnValue([role({ role: 'admin', agent_group_id: null })]);
    const s = describeRoleChange('grant', { user: 'slack:U0123', role: 'admin' });
    const { question } = renderRoleChangeCard(s, ORIGIN);
    expect(question).toContain('No effect: the user already holds this role');
  });

  it('demotes the raw command to a trailing secondary detail', () => {
    const s = describeRoleChange('grant', { user: 'slack:U0123', role: 'admin' });
    const { question } = renderRoleChangeCard(s, ORIGIN);
    expect(question).toContain('_Command:_ `ncl roles-grant --user slack:U0123 --role admin`');
    // headline is the action, command is last
    expect(question.indexOf('*Action:*')).toBeLessThan(question.indexOf('_Command:_'));
  });
});
