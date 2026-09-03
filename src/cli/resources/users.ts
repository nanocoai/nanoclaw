import { registerResource } from '../crud.js';

registerResource({
  name: 'user',
  plural: 'users',
  table: 'users',
  description:
    'User — a messaging-platform identity. Each row is one sender on one channel. A single human may have multiple user rows across channels (no cross-channel linking yet).',
  idColumn: 'id',
  columns: [
    {
      name: 'id',
      type: 'string',
      description:
        'Namespaced "channel_type:handle" — e.g. "tg:6037840640", "discord:123456789", "email:user@example.com". Must be provided on create.',
      required: true,
    },
    {
      name: 'kind',
      type: 'string',
      description:
        'Channel type identifier (e.g. "telegram", "discord"). Used as a fallback for DM resolution when the id prefix doesn\'t match a registered adapter.',
      required: true,
    },
    {
      name: 'display_name',
      type: 'string',
      description:
        'Human-readable name. Shown in approval cards and logs. Often auto-populated from the channel adapter.',
      updatable: true,
    },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  // Idempotent create on the user id, so re-wiring the same owner is a no-op.
  naturalKey: ['id'],
  operations: { list: 'open', get: 'open', create: 'approval', update: 'approval' },
});
