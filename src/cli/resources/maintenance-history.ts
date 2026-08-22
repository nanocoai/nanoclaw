/**
 * Read-only maintenance history queries, callable by Maintenance
 * Coordinator's own container (cli_scope: 'group' -- see
 * GROUP_SCOPE_RESOURCES in ../registry.ts). No standard CRUD verbs: this
 * resource is two computed capabilities over durable MC tables, not a
 * table of its own. See ../../modules/maintenance-worker-actions/history.ts
 * for the query logic and the honest caveats on non-structured fields
 * (e.g. property filtering).
 *
 * `access: 'open'` on both -- reading already-recorded history is no more
 * sensitive than `ncl sessions list`/`ncl workers ...` already are for a
 * group-scoped agent, and nothing here can hold/carry a worker-facing
 * side effect (no writes, no wakes).
 */
import { getWorkerActivityHistory, getWorkerTimeHistory } from '../../modules/maintenance-worker-actions/index.js';
import { registerResource } from '../crud.js';

registerResource({
  name: 'maintenance-history',
  plural: 'maintenance-history',
  table: 'worker_time_events',
  description:
    "Read-only historical queries over Maintenance Coordinator's durable worker time/activity records. Not a CRUD resource -- see the two custom operations.",
  idColumn: 'id',
  columns: [],
  operations: {},
  customOperations: {
    'worker-time-history': {
      access: 'open',
      description:
        'Durable clock-in/out history for one worker over a date range, grouped by day, with total hours and ' +
        'any incomplete days flagged explicitly. Source of truth is worker_time_events (append-only) -- never ' +
        "worker_state's current-status memory. Never invents a missing punch.",
      examples: [
        'ncl maintenance-history worker-time-history --worker Elehazar --start 2026-08-17T00:00:00.000Z --end 2026-08-24T00:00:00.000Z',
      ],
      args: [
        { name: 'worker', type: 'string', description: "Worker name or user_id (e.g. \"Elehazar\" or \"telegram:123\").", required: true },
        { name: 'start', type: 'string', description: 'Range start, ISO-8601 UTC.', required: true },
        { name: 'end', type: 'string', description: 'Range end, ISO-8601 UTC.', required: true },
      ],
      handler: async (args) => {
        const result = await getWorkerTimeHistory(args.worker as string, args.start as string, args.end as string);
        if (!result.ok) throw new Error(result.reason);
        return result;
      },
    },
    'worker-activity-history': {
      access: 'open',
      description:
        'Merged, chronological structured history from every durable MC record type (worker activity log, time ' +
        'events, job completions, reported issues) -- never transcript inference. Worker/date-range/property are ' +
        'all optional filters; see the returned `caveats` array when filtering by property (not every table has ' +
        'a structured property column yet).',
      examples: ['ncl maintenance-history worker-activity-history --worker Ivan --start 2026-08-17T00:00:00.000Z'],
      args: [
        { name: 'worker', type: 'string', description: 'Worker name or user_id. Omit for all workers.' },
        { name: 'start', type: 'string', description: 'Range start, ISO-8601 UTC. Omit for no lower bound.' },
        { name: 'end', type: 'string', description: 'Range end, ISO-8601 UTC. Omit for no upper bound.' },
        { name: 'property', type: 'string', description: 'Property reference/address to filter by (see caveats on match quality).' },
      ],
      handler: async (args) => {
        const result = await getWorkerActivityHistory({
          worker: args.worker as string | undefined,
          start: args.start as string | undefined,
          end: args.end as string | undefined,
          property: args.property as string | undefined,
        });
        if (!result.ok) throw new Error(result.reason);
        return result;
      },
    },
  },
});
