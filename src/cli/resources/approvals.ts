import { registerResource } from '../crud.js';
import { listPendingSenderApprovals } from '../../modules/permissions/db/pending-sender-approvals.js';

registerResource({
  name: 'approval',
  plural: 'approvals',
  table: 'pending_approvals',
  description:
    'Pending approval — in-flight approval cards waiting for an admin response. Created by requestApproval() (self-mod install_packages/add_mcp_server) and OneCLI credential approval flow. Rows are deleted after the admin approves/rejects or the request expires.',
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
      description: 'Session that requested the approval. Null for OneCLI credential approvals.',
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
        "Action type — matches the registered approval handler (e.g. install_packages, add_mcp_server, onecli_credential). 'sender_admit' rows are unknown-sender holds folded in from pending_sender_approvals; they resolve through the same click path.",
    },
    { name: 'payload', type: 'json', description: 'JSON payload carried through to the approval handler.' },
    { name: 'created_at', type: 'string', description: 'Auto-set.' },
    { name: 'agent_group_id', type: 'string', description: 'Originating agent group.' },
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
      enum: ['pending', 'approved', 'rejected', 'expired'],
    },
    { name: 'title', type: 'string', description: 'Card title shown to the admin.' },
    { name: 'options_json', type: 'json', description: 'Card button options as JSON array.' },
  ],
  operations: { list: 'open', get: 'open' },
  // Unknown-sender holds live in their own table (pending_sender_approvals),
  // but resolve through the same click path (handleSenderApprovalResponse
  // claims the same questionId). Fold them into this list as
  // action:'sender_admit' so an operator can see and act on every pending hold
  // from one surface. Self-filter on the list filters so `--status`/`--action`
  // stay honest; these rows are always pending until approve/deny deletes them.
  extraListRows: (args) => {
    if (args.action !== undefined && args.action !== 'sender_admit') return [];
    if (args.status !== undefined && args.status !== 'pending') return [];
    return listPendingSenderApprovals().map((row) => ({
      approval_id: row.id,
      session_id: null,
      request_id: row.id,
      action: 'sender_admit',
      payload: row.original_message,
      created_at: row.created_at,
      agent_group_id: row.agent_group_id,
      channel_type: null,
      platform_id: null,
      platform_message_id: null,
      expires_at: null,
      status: 'pending',
      title: row.title,
      options_json: row.options_json,
    }));
  },
});
