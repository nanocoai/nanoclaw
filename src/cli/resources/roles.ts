import type { RoleScopeDescription } from '../../modules/permissions/db/user-roles.js';
import type { UserRoleKind } from '../../types.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { describeRoleScope } from '../../modules/permissions/db/user-roles.js';
import { registerResource } from '../crud.js';

/**
 * Scope-affirmation mechanism (issue A1).
 *
 * A role grant is a high-blast-radius write, so scope is a REQUIRED, explicit
 * choice — never an implicit default. We use a `--scope global|group` flag
 * rather than "omit --group means global", because a missing flag is
 * indistinguishable from forgetfulness. Chosen over a bare `--global` flag so
 * the two scopes read symmetrically in help and in the agent's command, and so
 * omission fails loudly instead of silently widening the blast radius.
 *
 * Rules (applied to BOTH grant and revoke so you can't ambiguously target the
 * global row vs a group row):
 *   --scope global  → agent_group_id = null; --group must NOT be passed.
 *   --scope group   → --group is required; agent_group_id = that group.
 *   owner           → must be --scope global (owner is always global).
 *   (omitted scope) → ERROR.
 *
 * Note (issue A4, tracked separately): agent-facing prompt/doc guidance should
 * spell out that granting global admin/owner is rarely what's intended — the
 * required scope choice here is the enforcement, the prompt is the nudge.
 */
function resolveScope(args: Record<string, unknown>, role: string): string | null {
  const scope = args.scope as string | undefined;
  const groupId = (args.group as string) ?? null;

  if (!scope) {
    throw new Error(
      '--scope is required (global|group). Use "--scope group --group <id>" for a single agent group, ' +
        'or "--scope global" to grant across ALL agent groups. Scope is never assumed.',
    );
  }
  if (scope !== 'global' && scope !== 'group') {
    throw new Error('--scope must be "global" or "group"');
  }

  if (scope === 'global') {
    if (groupId) throw new Error('--scope global grants across all groups; do not also pass --group');
    return null;
  }

  // scope === 'group'
  if (role === 'owner')
    throw new Error('owner role is always global — use --scope global (do not scope owner to a group)');
  if (!groupId) throw new Error('--scope group requires --group <agent_group_id>');
  return groupId;
}

function withArticle(desc: RoleScopeDescription): string {
  if (desc.privilege === 'owner') return `the ${desc.label}`;
  return /^[aeiou]/i.test(desc.label) ? `an ${desc.label}` : `a ${desc.label}`;
}

registerResource({
  name: 'role',
  plural: 'roles',
  table: 'user_roles',
  description:
    'User role — privilege grant. "owner" is always global and has full control. "admin" can be global (agent_group_id null) or scoped to a specific agent group. Admin at a group implies membership. Scope is an explicit, required choice on grant/revoke (--scope global|group); it is never assumed. Approval routing prefers admins/owners reachable on the same messaging platform as the request origin (e.g. a Telegram request routes the approval card to an admin on Telegram when possible).',
  idColumn: 'user_id',
  columns: [
    { name: 'user_id', type: 'string', description: 'User receiving the role. Must exist in users table.' },
    {
      name: 'role',
      type: 'string',
      description: '"owner" has full control, always global. "admin" can manage groups and approve actions.',
      enum: ['owner', 'admin'],
    },
    {
      name: 'agent_group_id',
      type: 'string',
      description:
        'Null = global (all groups). A specific ID limits the role to that group. Owner must always be null.',
    },
    { name: 'granted_by', type: 'string', description: 'Who granted this role. Informational.' },
    { name: 'granted_at', type: 'string', description: 'Auto-set.' },
  ],
  operations: { list: 'open' },
  customOperations: {
    grant: {
      access: 'approval',
      description:
        'Grant a role. Requires --user, --role, and --scope (global|group). ' +
        'For --scope group also pass --group <agent_group_id>. Omitting --scope errors — global is never the silent default.',
      args: [
        { name: 'user', type: 'string', description: 'User receiving the role.', required: true },
        { name: 'role', type: 'string', description: 'owner or admin.', enum: ['owner', 'admin'], required: true },
        {
          name: 'scope',
          type: 'string',
          description: 'Required. "global" = ALL agent groups; "group" = one group (then --group is required).',
          enum: ['global', 'group'],
          required: true,
        },
        { name: 'group', type: 'string', description: 'Agent group ID. Required (and only valid) with --scope group.' },
        { name: 'granted_by', type: 'string', description: 'Who granted this role. Informational.' },
      ],
      handler: async (args) => {
        const userId = args.user as string;
        const role = args.role as string;
        const grantedBy = (args.granted_by as string) ?? null;
        if (!userId) throw new Error('--user is required');
        if (!role || !['owner', 'admin'].includes(role)) throw new Error('--role must be owner or admin');

        const groupId = resolveScope(args, role);

        getDb()
          .prepare(
            `INSERT OR IGNORE INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(userId, role, groupId, grantedBy, new Date().toISOString());

        const groupName = groupId ? (getAgentGroup(groupId)?.name ?? null) : null;
        const desc = describeRoleScope(role as UserRoleKind, groupId, groupName);
        return {
          user_id: userId,
          role,
          agent_group_id: groupId,
          agent_group_name: groupName,
          privilege: desc.privilege,
          summary: `${userId} is now ${withArticle(desc)} — ${desc.capabilities}.`,
        };
      },
    },
    revoke: {
      access: 'approval',
      description:
        'Revoke a role. Requires --user, --role, and --scope (global|group) so you cannot ambiguously ' +
        'target the global grant vs a group grant. For --scope group also pass --group <agent_group_id>.',
      args: [
        { name: 'user', type: 'string', description: 'User whose role is being revoked.', required: true },
        { name: 'role', type: 'string', description: 'owner or admin.', enum: ['owner', 'admin'], required: true },
        {
          name: 'scope',
          type: 'string',
          description: 'Required. Which grant to remove: "global" or "group" (then --group is required).',
          enum: ['global', 'group'],
          required: true,
        },
        { name: 'group', type: 'string', description: 'Agent group ID. Required (and only valid) with --scope group.' },
      ],
      handler: async (args) => {
        const userId = args.user as string;
        const role = args.role as string;
        if (!userId) throw new Error('--user is required');
        if (!role || !['owner', 'admin'].includes(role)) throw new Error('--role must be owner or admin');

        const groupId = resolveScope(args, role);

        const result = getDb()
          .prepare('DELETE FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id IS ?')
          .run(userId, role, groupId);
        if (result.changes === 0) throw new Error('role not found');

        const groupName = groupId ? (getAgentGroup(groupId)?.name ?? null) : null;
        const desc = describeRoleScope(role as UserRoleKind, groupId, groupName);
        return {
          revoked: { user_id: userId, role, agent_group_id: groupId, agent_group_name: groupName },
          privilege: desc.privilege,
          summary: `${userId} is no longer ${withArticle(desc)} (revoked: ${desc.capabilities}).`,
        };
      },
    },
  },
});
