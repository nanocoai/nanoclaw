import { getDb } from '../../db/connection.js';
import { registerResource } from '../crud.js';

registerResource({
  name: 'role',
  plural: 'roles',
  table: 'user_roles',
  description:
    'User role — privilege grant. "owner" is always global and has full control. "admin" can be global (agent_group_id null) or scoped to a specific agent group. Admin at a group implies membership. Approval routing prefers admins/owners reachable on the same messaging platform as the request origin (e.g. a Telegram request routes the approval card to an admin on Telegram when possible).',
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
      description: 'Grant a role. Use --user, --role, and optionally --group for scoped admin.',
      handler: async (args) => {
        const userId = args.user as string;
        const role = args.role as string;
        const groupId = (args.group as string) ?? null;
        const grantedBy = (args.granted_by as string) ?? null;
        if (!userId) throw new Error('--user is required');
        if (!role || !['owner', 'admin'].includes(role)) throw new Error('--role must be owner or admin');
        if (role === 'owner' && groupId) throw new Error('owner role is always global (do not pass --group)');
        getDb()
          .prepare(
            `INSERT OR IGNORE INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(userId, role, groupId, grantedBy, new Date().toISOString());
        return { user_id: userId, role, agent_group_id: groupId };
      },
    },
    revoke: {
      access: 'approval',
      description: 'Revoke a role. Use --user, --role, and --group if scoped.',
      handler: async (args) => {
        const userId = args.user as string;
        const role = args.role as string;
        const groupId = (args.group as string) ?? null;
        if (!userId) throw new Error('--user is required');
        if (!role) throw new Error('--role is required');
        const result = getDb()
          .prepare('DELETE FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id IS ?')
          .run(userId, role, groupId);
        if (result.changes === 0) throw new Error('role not found');
        return { revoked: { user_id: userId, role, agent_group_id: groupId } };
      },
    },
  },
});
