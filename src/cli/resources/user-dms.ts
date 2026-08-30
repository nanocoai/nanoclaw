import { ensureUserDm } from '../../modules/permissions/user-dm.js';
import { registerResource } from '../crud.js';

registerResource({
  name: 'user-dm',
  plural: 'user-dms',
  table: 'user_dms',
  description:
    "User DM cache — maps (user, channel_type) to the messaging group used for DM delivery. Populated lazily by ensureUserDm() when the host needs to cold-DM a user (approvals, pairing). For direct-addressable channels (Telegram, WhatsApp) the handle IS the DM chat ID. For resolution-required channels (Discord, Slack) the adapter's openDM resolves it.",
  idColumn: 'user_id',
  listOrder: 'resolved_at DESC, user_id, channel_type',
  columns: [
    { name: 'user_id', type: 'string', description: 'User this DM route is for.' },
    { name: 'channel_type', type: 'string', description: 'Channel adapter type.' },
    {
      name: 'messaging_group_id',
      type: 'string',
      description: 'The messaging group used to deliver DMs to this user on this channel.',
    },
    { name: 'resolved_at', type: 'string', description: 'When this DM route was last resolved.' },
  ],
  operations: { list: 'open' },
  customOperations: {
    ensure: {
      access: 'approval',
      description: 'Resolve or create the direct-message route for --user.',
      handler: async (args) => {
        const userId = args.user as string;
        if (!userId) throw new Error('--user is required');
        const messagingGroup = await ensureUserDm(userId);
        if (!messagingGroup) throw new Error(`user is unreachable by DM: ${userId}`);
        return messagingGroup;
      },
    },
  },
});
