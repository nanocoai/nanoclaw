/**
 * `ncl traces` — read-only view of recorded agent turns.
 *
 * Host-only: traces can hold prompt and tool content from every agent group,
 * so no container caller may read them, whatever its cli_scope.
 */
import { registerResource, type ColumnDef } from '../../cli/crud.js';
import { TURN_STATUSES } from './apply.js';
import { getTurnTrace, listTurnTraces, type TurnTraceRow } from './db.js';
import { pruneExpiredTurnTraces } from './retention.js';

const PREVIEW_CHARS = 120;
const DEFAULT_LIMIT = 20;

const COLUMNS: ColumnDef[] = [
  { name: 'id', type: 'string', description: 'Trace id.' },
  { name: 'session_id', type: 'string', description: 'Session that ran the turn.' },
  { name: 'agent_group_id', type: 'string', description: 'Agent group that ran the turn.' },
  { name: 'turn_id', type: 'string', description: 'Id of the first inbound message the turn answered.' },
  { name: 'message_ids', type: 'json', description: 'Every inbound message id in the batch.' },
  { name: 'provider', type: 'string', description: 'Agent provider.' },
  { name: 'model', type: 'string', description: 'Configured model, when the group sets one.' },
  { name: 'status', type: 'string', description: 'How the turn ended.', enum: [...TURN_STATUSES] },
  { name: 'started_at', type: 'string', description: 'When the batch reached the agent.' },
  { name: 'ended_at', type: 'string', description: 'When the turn ended.' },
  { name: 'duration_ms', type: 'number', description: 'Wall-clock turn time.' },
  { name: 'input', type: 'string', description: 'Inbound message content (capped).' },
  { name: 'output', type: 'string', description: 'Final result text (capped).' },
  { name: 'error', type: 'string', description: 'Provider error, when the turn failed.' },
  { name: 'tool_call_count', type: 'number', description: 'Tool calls recorded in the turn.' },
  { name: 'steps', type: 'json', description: 'Ordered tool calls and mid-turn text (inputs/outputs capped).' },
  { name: 'steps_dropped', type: 'number', description: 'Steps past the per-turn cap that were not kept.' },
  { name: 'created_at', type: 'string', description: 'When the host stored the trace.' },
];

function preview(value: string | null): string | null {
  if (value === null) return null;
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_CHARS ? flat.slice(0, PREVIEW_CHARS) + '…' : flat;
}

function summary(row: TurnTraceRow) {
  return {
    id: row.id,
    agent_group_id: row.agent_group_id,
    session_id: row.session_id,
    status: row.status,
    model: row.model,
    started_at: row.started_at,
    duration_ms: row.duration_ms,
    tool_call_count: row.tool_call_count,
    output: preview(row.output ?? row.error),
  };
}

function detail(row: TurnTraceRow) {
  return { ...row, message_ids: JSON.parse(row.message_ids) as unknown, steps: JSON.parse(row.steps) as unknown };
}

registerResource({
  name: 'trace',
  plural: 'traces',
  table: 'turn_traces',
  description:
    'Turn trace — one agent turn: inbound content, tool calls, mid-turn text, final output, timings and model. Recorded by the add-turn-traces skill and pruned after TURN_TRACE_RETENTION_DAYS. Read-only and host-only.',
  idColumn: 'id',
  columns: COLUMNS,
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      hostOnly: true,
      description: 'List recent turns, newest first, with a one-line output preview.',
      args: [
        { name: 'agent_group_id', type: 'string', description: 'Only turns of this agent group.' },
        { name: 'session_id', type: 'string', description: 'Only turns of this session.' },
        { name: 'status', type: 'string', description: 'Only turns that ended this way.', enum: [...TURN_STATUSES] },
        { name: 'limit', type: 'number', description: `Max rows (default ${DEFAULT_LIMIT}).`, default: DEFAULT_LIMIT },
      ],
      examples: ['ncl traces list --agent-group-id ag-123 --status error'],
      handler: async (args) => {
        await pruneExpiredTurnTraces();
        const rows = await listTurnTraces({
          agentGroupId: args.agent_group_id as string | undefined,
          sessionId: args.session_id as string | undefined,
          status: args.status as string | undefined,
          limit: Math.max(1, Math.floor(args.limit as number)),
        });
        return rows.map(summary);
      },
    },
    get: {
      access: 'open',
      hostOnly: true,
      description: 'Show one turn in full, including every recorded step.',
      args: [{ name: 'id', type: 'string', description: 'Trace id (from `ncl traces list`).', required: true }],
      examples: ['ncl traces get 3f2c9a1e-...'],
      handler: async (args) => {
        await pruneExpiredTurnTraces();
        const row = await getTurnTrace(args.id as string);
        if (!row) throw new Error(`trace not found: ${String(args.id)}`);
        return detail(row);
      },
    },
  },
});
