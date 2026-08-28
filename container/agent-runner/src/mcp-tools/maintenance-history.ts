/**
 * Maintenance Coordinator's read-only historical-query tools.
 *
 * Built for Pepper's feature request: private Pepper has no direct DB
 * access, so historical maintenance questions ("what hours did Elehazar
 * work this week?", "what did Ivan say this morning?") route through
 * Maintenance Coordinator via A2A instead. These tools are what MC's own
 * model calls once it receives such a question -- they never touch the
 * central DB or another session's DB directly (a container only ever
 * mounts its own session's inbound.db/outbound.db); each one shells out to
 * `ncl`, the container's session-DB CLI transport, which round-trips the
 * request to the host where the real handlers in
 * src/cli/resources/maintenance-history.ts and
 * .../maintenance-transcript.ts run with full central-DB access. See
 * container/Dockerfile's "ncl CLI wrapper" for why `ncl` is a real binary
 * on PATH inside this container.
 *
 * All three tools are read-only: they never call send_message, never
 * write to any session, never wake another container.
 */
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

interface NclResponse {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

/**
 * Spawn `ncl <command> --json --<key> <value> ...` and parse the response
 * frame. Args with `undefined`/empty values are omitted rather than passed
 * as empty flags.
 */
async function runNcl(command: string, args: Record<string, string | number | undefined>): Promise<NclResponse> {
  const flags: string[] = [command, '--json'];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === '') continue;
    flags.push(`--${key.replace(/_/g, '-')}`, String(value));
  }

  const proc = Bun.spawn(['ncl', ...flags], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0 && !stdout.trim()) {
    return { ok: false, error: { code: 'transport-error', message: stderr.trim() || `ncl exited ${exitCode}` } };
  }
  try {
    return JSON.parse(stdout) as NclResponse;
  } catch {
    return { ok: false, error: { code: 'transport-error', message: `unparseable ncl output: ${stdout.slice(0, 500)}` } };
  }
}

export const getWorkerTimeHistory: McpToolDefinition = {
  tool: {
    name: 'get_worker_time_history',
    description:
      'Durable clock-in/out history for one worker over a date range, grouped by day, with total hours and any ' +
      'incomplete days (a clock_in with no matching clock_out, or vice versa) flagged explicitly. Source of truth ' +
      'is the append-only time-event log, never current-status memory. Never invents a missing punch -- an ' +
      'incomplete day is reported as incomplete, not silently completed or estimated. Use this whenever asked ' +
      'about hours worked, e.g. from private Pepper via A2A ("what hours did Elehazar work this week?").',
    inputSchema: {
      type: 'object' as const,
      properties: {
        worker: { type: 'string', description: 'Worker name or user_id (e.g. "Elehazar").' },
        start: { type: 'string', description: 'Range start, ISO-8601 UTC.' },
        end: { type: 'string', description: 'Range end, ISO-8601 UTC.' },
      },
      required: ['worker', 'start', 'end'],
    },
  },
  async handler(args) {
    const resp = await runNcl('maintenance-history-worker-time-history', {
      worker: args.worker as string,
      start: args.start as string,
      end: args.end as string,
    });
    if (!resp.ok) return err(resp.error?.message ?? 'unknown error');
    log(`get_worker_time_history: ${args.worker as string}`);
    return ok(JSON.stringify(resp.data, null, 2));
  },
};

export const getWorkerActivityHistory: McpToolDefinition = {
  tool: {
    name: 'get_worker_activity_history',
    description:
      'Merged, chronological structured history from every durable MC record type (worker activity log, time ' +
      'events, job completions, reported issues) for one worker or all workers -- never transcript inference. ' +
      'worker/start/end/property are all optional filters. Check the returned `caveats` field when filtering by ' +
      'property: not every record type has a structured property column yet, so some matches are best-effort text.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        worker: { type: 'string', description: 'Worker name or user_id. Omit for all workers.' },
        start: { type: 'string', description: 'Range start, ISO-8601 UTC. Omit for no lower bound.' },
        end: { type: 'string', description: 'Range end, ISO-8601 UTC. Omit for no upper bound.' },
        property: { type: 'string', description: 'Property reference/address to filter by.' },
      },
    },
  },
  async handler(args) {
    const resp = await runNcl('maintenance-history-worker-activity-history', {
      worker: args.worker as string | undefined,
      start: args.start as string | undefined,
      end: args.end as string | undefined,
      property: args.property as string | undefined,
    });
    if (!resp.ok) return err(resp.error?.message ?? 'unknown error');
    log(`get_worker_activity_history: worker=${(args.worker as string) ?? '(all)'}`);
    return ok(JSON.stringify(resp.data, null, 2));
  },
};

export const searchMaintenanceTranscript: McpToolDefinition = {
  tool: {
    name: 'search_maintenance_transcript',
    description:
      "Search the real Maintenance group's own message history -- \"what did the workers say this morning?\", " +
      'messages from one worker, keyword search within a date range. Read-only, and always scoped to this exact ' +
      "group's own conversation -- fails closed rather than guessing if that conversation is ambiguous or " +
      'missing. Returns sender, timestamp, text, and attachment metadata (never attachment content). Use this for ' +
      'anything about what a worker actually said, e.g. from private Pepper via A2A ("what did Ivan say this ' +
      'morning?", "translate what was said in Maintenance today").',
    inputSchema: {
      type: 'object' as const,
      properties: {
        start: { type: 'string', description: 'Range start, ISO-8601 UTC.' },
        end: { type: 'string', description: 'Range end, ISO-8601 UTC.' },
        worker: { type: 'string', description: 'Substring match against sender name/id.' },
        keyword: { type: 'string', description: 'Substring match against message text.' },
        limit: { type: 'number', description: 'Max results returned (default 200, capped at 2000).' },
      },
    },
  },
  async handler(args) {
    const resp = await runNcl('maintenance-transcript-search', {
      start: args.start as string | undefined,
      end: args.end as string | undefined,
      worker: args.worker as string | undefined,
      keyword: args.keyword as string | undefined,
      limit: args.limit as number | undefined,
    });
    if (!resp.ok) return err(resp.error?.message ?? 'unknown error');
    log(`search_maintenance_transcript: keyword=${(args.keyword as string) ?? '(none)'}`);
    return ok(JSON.stringify(resp.data, null, 2));
  },
};

registerTools([getWorkerTimeHistory, getWorkerActivityHistory, searchMaintenanceTranscript]);
