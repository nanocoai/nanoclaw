import { registerResource } from '../crud.js';

registerResource({
  name: 'approval',
  plural: 'approvals',
  table: 'approval_holds',
  description:
    'Pending approval hold — one read-only view across module, sender-admission, OneCLI credential, and channel-registration flows. Rows are removed after resolution or expiry.',
  idColumn: 'approval_id',
  columns: [
    {
      name: 'approval_id',
      type: 'string',
      description: 'Unique approval identifier (also used as the card questionId).',
    },
    {
      name: 'session_id',
      type: 'string',
      description: 'Session that requested the approval. Null for sessionless sender, OneCLI, and channel holds.',
    },
    {
      name: 'request_id',
      type: 'string',
      description: 'Original request identifier (OneCLI request UUID or same as approval_id).',
    },
    {
      name: 'action',
      type: 'string',
      description:
        'Action type — matches the registered approval handler (e.g. install_packages, add_mcp_server, onecli_credential).',
    },
    { name: 'payload', type: 'json', description: 'JSON payload carried through to the approval handler.' },
    { name: 'created_at', type: 'string', description: 'Auto-set.' },
    { name: 'agent_group_id', type: 'string', description: 'Originating agent group.' },
    {
      name: 'messaging_group_id',
      type: 'string',
      description: 'Chat/channel the held action concerns (sender admission and channel registration).',
    },
    {
      name: 'subject_user_id',
      type: 'string',
      description: 'User the held action concerns (sender admission).',
    },
    {
      name: 'subject_name',
      type: 'string',
      description: 'Display name of the user the held action concerns, when known.',
    },
    { name: 'channel_type', type: 'string', description: 'Channel the approval card was delivered on.' },
    { name: 'platform_id', type: 'string', description: 'Platform chat ID the card was delivered to.' },
    {
      name: 'platform_message_id',
      type: 'string',
      description: 'Platform message ID of the delivered card (for editing on expiry).',
    },
    { name: 'expires_at', type: 'string', description: 'When this approval expires (OneCLI gateway TTL).' },
    {
      name: 'status',
      type: 'string',
      description: 'Current status.',
      enum: ['pending', 'approved', 'rejected', 'expired', 'awaiting_reason'],
    },
    { name: 'title', type: 'string', description: 'Card title shown to the admin.' },
    { name: 'options_json', type: 'json', description: 'Card button options as JSON array.' },
    {
      name: 'approver_user_id',
      type: 'string',
      description: 'Named approver (exclusive) or the admin the card was delivered to (admins-of-scope).',
    },
    {
      name: 'approver_rule',
      type: 'string',
      description: 'Who may resolve: only the named approver, or the admin chain of the anchoring group.',
      enum: ['exclusive', 'admins-of-scope'],
    },
    { name: 'dedup_key', type: 'string', description: 'In-flight dedup key (e.g. sender admission per chat+sender).' },
  ],
  operations: { list: 'open', get: 'open' },
});
