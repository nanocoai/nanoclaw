import { rejectPendingApproval } from '../../modules/approvals/index.js';
import { PENDING_APPROVAL_STATUSES } from '../../types.js';
import { registerResource } from '../crud.js';

registerResource({
  name: 'approval',
  plural: 'approvals',
  table: 'pending_approvals',
  description:
    'Pending approval — in-flight approval cards waiting for an admin response. Created by registered modules or the selected gateway. Rows are deleted after the admin approves/rejects, after `ncl approvals reject`, or when the request expires (gateway TTL; module-initiated cards after 7 days unanswered).',
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
      description: 'Session that requested the approval. May be null for gateway-owned approvals.',
    },
    {
      name: 'request_id',
      type: 'string',
      description: 'Original provider request identifier or the same value as approval_id.',
    },
    {
      name: 'action',
      type: 'string',
      description: 'Action type — matches a registered module or gateway response handler.',
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
    { name: 'expires_at', type: 'string', description: 'When this approval expires, if provider-gated.' },
    {
      name: 'status',
      type: 'string',
      description:
        'Current status. awaiting_reason means the admin chose "Reject with reason…" and the reply is still pending.',
      enum: [...PENDING_APPROVAL_STATUSES],
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
