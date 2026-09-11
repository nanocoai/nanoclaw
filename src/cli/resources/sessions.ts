import {
  formatHistoryLines,
  HISTORY_DEFAULT_LIMIT,
  sessionHistory,
  type HistoryRow,
} from '../../modules/cross-session-context/index.js';
import { registerResource } from '../crud.js';

registerResource({
  name: 'session',
  plural: 'sessions',
  table: 'sessions',
  description:
    'Session — the runtime unit. Maps one (agent_group, messaging_group, thread) combination to a container with its own inbound.db and outbound.db. Created automatically by the router when a message arrives.',
  idColumn: 'id',
  scopeField: 'agent_group_id',
  columns: [
    { name: 'id', type: 'string', description: 'UUID.', generated: true },
    { name: 'agent_group_id', type: 'string', description: 'Agent group this session runs.' },
    {
      name: 'messaging_group_id',
      type: 'string',
      description: 'Messaging group this session serves. Null for agent-shared sessions.',
    },
    {
      name: 'thread_id',
      type: 'string',
      description: 'Thread ID. Only set for per-thread session mode.',
    },
    {
      name: 'agent_provider',
      type: 'string',
      description: 'Provider override. Null means inherit from agent group.',
    },
    {
      name: 'status',
      type: 'string',
      description: '"active" receives messages. "closed" is archived.',
      enum: ['active', 'closed'],
    },
    {
      name: 'container_status',
      type: 'string',
      description:
        '"running" — container alive and polling. "stopped" — container exited; the sweep will restart it automatically when due messages arrive. "idle" — reserved, currently unused.',
      enum: ['running', 'idle', 'stopped'],
    },
    { name: 'last_active', type: 'string', description: 'Last message or heartbeat. Used for stale detection.' },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  operations: { list: 'open', get: 'open' },
  customOperations: {
    history: {
      access: 'open',
      description:
        'Read a session transcript: inbound + outbound messages merged chronologically.\n\n' +
        'Output: pipe-separated lines "timestamp|direction(in/out)|kind|sender|text" (text capped at ' +
        '200 chars), the newest --limit rows in chronological order; `--json` returns the raw rows ' +
        'with ISO timestamps and uncapped text. Use after `ncl sessions list` to ' +
        'catch up fully on another conversation of your agent group (you only ever see your own ' +
        "group's sessions).",
      examples: [`# Catch up on another session of your group:\nncl sessions history sess-1751234-abc123 --limit 100`],
      args: [
        { name: 'id', type: 'string', description: 'Session id (from `ncl sessions list`).', required: true },
        {
          name: 'limit',
          type: 'number',
          description: `Max rows returned, newest first (default ${HISTORY_DEFAULT_LIMIT}).`,
          default: HISTORY_DEFAULT_LIMIT,
        },
      ],
      // Self-scoped in the handler: custom ops bypass the dispatcher's generic
      // scope post-filter, so cross-group callers get "session not found"
      // (the dispatcher's sessions pre-handler check covers this verb too).
      handler: async (args, ctx) => await sessionHistory(args, ctx),
      formatHuman: (data) => formatHistoryLines(data as HistoryRow[]),
    },
  },
});
