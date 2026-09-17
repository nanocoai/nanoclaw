import { rejectPendingApproval } from '../../modules/approvals/index.js';
import { registerResource } from '../crud.js';

registerResource({
  name: 'approval',
  plural: 'approvals',
  table: 'pending_approvals',
  description:
    'Pending approval — in-flight approval cards waiting for an admin response. Created by requestApproval() (self-mod install_packages/add_mcp_server) and OneCLI credential approval flow. Rows are deleted after the admin approves/rejects, after `ncl approvals reject`, or when the request expires (OneCLI gateway TTL; module-initiated cards after 7 days unanswered).',
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
        'Action type — matches the registered approval handler (e.g. install_packages, add_mcp_server, onecli_credential).',
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
  customOperations: {
    reject: {
      access: 'open',
      description:
        'Reject a pending approval by id — the same outcome as pressing Reject on its card.\n\n' +
        'For clearing a card whose buttons can no longer be used (a stale or lost card). The requesting ' +
        'agent is told its request was rejected; if its session is gone the row is simply removed. ' +
        'There is deliberately no by-id approve: approving stays a human decision made on the card.',
      args: [
        { name: 'id', type: 'string', description: 'Approval id (from `ncl approvals list`).', required: true },
        { name: 'reason', type: 'string', description: 'Optional one-line reason relayed to the requesting agent.' },
      ],
      examples: [
        'ncl approvals reject appr-1789503209201-6wqpil',
        'ncl approvals reject appr-… --reason "No longer needed"',
      ],
      handler: async (args, ctx) => {
        const approvalId = args.id as string;
        const userId = ctx.caller === 'agent' ? `agent:${ctx.agentGroupId}` : 'host';
        const outcome = await rejectPendingApproval(approvalId, userId, args.reason as string | undefined);
        return { approval_id: approvalId, outcome };
      },
    },
  },
});
