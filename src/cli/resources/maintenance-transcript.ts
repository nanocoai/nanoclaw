/**
 * Read-only Maintenance-group transcript search -- see
 * ../../modules/maintenance-transcript/search.ts for the scoping rule
 * (always the caller's own single channel-bound session, fails closed if
 * ambiguous; never accepts an explicit session id, unlike
 * `ncl sessions history`).
 *
 * `agent_group_id` is auto-filled to the caller's own group for
 * cli_scope: 'group' agents (see dispatch.ts's group-scope mechanics) --
 * a group-scoped MC container never needs to pass it and can never
 * override it to another group's id.
 */
import { searchMaintenanceTranscript } from '../../modules/maintenance-transcript/index.js';
import { registerResource } from '../crud.js';

registerResource({
  name: 'maintenance-transcript',
  plural: 'maintenance-transcript',
  table: 'messages_in',
  description:
    "Read-only search over the caller's own Maintenance-group session transcript. Not a CRUD resource -- see the `search` custom operation.",
  idColumn: 'id',
  columns: [],
  operations: {},
  customOperations: {
    search: {
      access: 'open',
      description:
        "Search the caller's own single channel-bound session (e.g. Maintenance Coordinator's real worker Telegram " +
        'group). Fails closed if the agent group has zero or more than one active channel-bound session. Filters ' +
        'are all optional and combine with AND: date range, worker (substring match on sender name/id), keyword ' +
        '(substring match on message text). Preserves sender, timestamp, text, and attachment metadata (name/type/url ' +
        'only -- never attachment content). Read-only: never sends anything, never wakes a container.',
      examples: [
        'ncl maintenance-transcript search --start 2026-08-22T00:00:00.000Z --keyword "not working"',
        'ncl maintenance-transcript search --worker Ivan --start 2026-08-22T06:00:00.000Z --end 2026-08-22T12:00:00.000Z',
      ],
      args: [
        { name: 'agent_group_id', type: 'string', description: 'Auto-filled for group-scoped agent callers.' },
        { name: 'start', type: 'string', description: 'Range start, ISO-8601 UTC.' },
        { name: 'end', type: 'string', description: 'Range end, ISO-8601 UTC.' },
        { name: 'worker', type: 'string', description: 'Substring match against sender name/id.' },
        { name: 'keyword', type: 'string', description: 'Substring match against message text.' },
        { name: 'limit', type: 'number', description: 'Max results returned (default 200, capped at 2000).' },
      ],
      handler: async (args) => {
        const agentGroupId = args.agent_group_id as string | undefined;
        if (!agentGroupId) throw new Error('agent_group_id is required (auto-filled for group-scoped agent callers)');
        const result = await searchMaintenanceTranscript({
          agentGroupId,
          start: args.start as string | undefined,
          end: args.end as string | undefined,
          worker: args.worker as string | undefined,
          keyword: args.keyword as string | undefined,
          limit: args.limit !== undefined ? Number(args.limit) : undefined,
        });
        if (!result.ok) throw new Error(result.reason);
        return result;
      },
    },
  },
});
