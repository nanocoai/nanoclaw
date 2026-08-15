import fs from 'fs';

import { getAllSessions, getSession, getSessionsByAgentGroup } from '../../db/sessions.js';
import { outboundDbPath, withOutboundDb } from '../../session-manager.js';
import { registerResource } from '../crud.js';
import { formatUsageTable, type UsageReport, type UsageRow } from '../format-usage.js';
import type { CallerContext } from '../frame.js';

/**
 * The key the container's poll loop accumulates its per-turn token totals
 * under, in each session's `outbound.db`. Mirrored here rather than imported:
 * host and container share no modules, only the two session DBs.
 */
const USAGE_KEY = 'token_usage';

/** Anything not a finite, non-negative number is not a count. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Summing floats otherwise leaves $0.030000000000000002 in the output. */
function roundCost(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Read one session's banked totals, or null if it has none.
 *
 * Null covers every way a session can fail to account for itself — never
 * started, DB removed, schema predates `session_state`, row unparseable. They
 * are deliberately not distinguished: the caller reports them as unmeasured,
 * and none of them means the session was free.
 */
function readSessionUsage(agentGroupId: string, sessionId: string): UsageRow | null {
  if (!fs.existsSync(outboundDbPath(agentGroupId, sessionId))) return null;
  let raw: string | undefined;
  try {
    raw = withOutboundDb(agentGroupId, sessionId, (db) => {
      const row = db.prepare('SELECT value FROM session_state WHERE key = ?').get(USAGE_KEY) as
        | { value: string }
        | undefined;
      return row?.value;
    });
  } catch {
    return null;
  }
  if (raw === undefined) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const input = count(parsed.input_tokens);
  const output = count(parsed.output_tokens);
  const cacheRead = count(parsed.cache_read_tokens);
  const cacheCreation = count(parsed.cache_creation_tokens);
  return {
    session_id: sessionId,
    agent_group_id: agentGroupId,
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: cacheCreation,
    // Cache reads and writes are billed tokens too; a total without them
    // understates a cache-heavy session several-fold.
    total_tokens: input + output + cacheRead + cacheCreation,
    cost_usd: count(parsed.cost_usd),
    turns: count(parsed.turns),
    updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : '',
  };
}

/**
 * Which sessions this caller may account for. An agent is pinned to its own
 * group regardless of what it passed; `--group` from an agent is never read.
 */
function selectedSessions(args: Record<string, unknown>, ctx: CallerContext): { id: string; group: string }[] {
  const sessionId = typeof args.session === 'string' ? args.session : undefined;
  if (sessionId) {
    const session = getSession(sessionId);
    if (!session || (ctx.caller === 'agent' && session.agent_group_id !== ctx.agentGroupId)) {
      // Same error either way, so this can't be used to probe another group.
      throw new Error(`session not found: ${sessionId}`);
    }
    return [{ id: session.id, group: session.agent_group_id }];
  }

  const group =
    ctx.caller === 'agent'
      ? ctx.agentGroupId
      : typeof args.group === 'string'
        ? args.group
        : typeof args.agent_group_id === 'string'
          ? args.agent_group_id
          : undefined;

  const sessions = group ? getSessionsByAgentGroup(group) : getAllSessions();
  return sessions.map((s) => ({ id: s.id, group: s.agent_group_id }));
}

function sessionsUsage(args: Record<string, unknown>, ctx: CallerContext): UsageReport {
  const rows: UsageRow[] = [];
  let unreported = 0;
  for (const { id, group } of selectedSessions(args, ctx)) {
    const usage = readSessionUsage(group, id);
    if (usage) rows.push(usage);
    else unreported += 1;
  }
  rows.sort((a, b) => b.total_tokens - a.total_tokens || a.session_id.localeCompare(b.session_id));

  const totals = rows.reduce(
    (acc, r) => ({
      input_tokens: acc.input_tokens + r.input_tokens,
      output_tokens: acc.output_tokens + r.output_tokens,
      cache_read_tokens: acc.cache_read_tokens + r.cache_read_tokens,
      cache_creation_tokens: acc.cache_creation_tokens + r.cache_creation_tokens,
      total_tokens: acc.total_tokens + r.total_tokens,
      cost_usd: acc.cost_usd + r.cost_usd,
      turns: acc.turns + r.turns,
      sessions: acc.sessions + 1,
    }),
    {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      total_tokens: 0,
      cost_usd: 0,
      turns: 0,
      sessions: 0,
    },
  );

  return { sessions: rows, totals: { ...totals, cost_usd: roundCost(totals.cost_usd) }, unreported };
}

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
    usage: {
      access: 'open',
      description:
        'Token and cost totals per session, as the provider reported them.\n\n' +
        "Read straight off each session's outbound.db, where the container banks one turn at a time, so the numbers survive container restarts and cover closed sessions too. Only providers that report usage contribute; sessions that reported nothing are counted separately rather than shown as zero, because unmeasured is not the same as free.\n\n" +
        'Host callers see every group by default; inside a container the report is always your own group.',
      args: [
        {
          name: 'group',
          type: 'string',
          description: 'Agent group id (host callers; always your own group inside a container).',
        },
        { name: 'session', type: 'string', description: 'Limit to one session id.' },
      ],
      examples: ['ncl sessions usage', 'ncl sessions usage --group ag-123', 'ncl sessions usage --session sess-abc'],
      handler: async (args, ctx) => sessionsUsage(args, ctx),
      formatHuman: (data) => formatUsageTable(data as UsageReport),
    },
  },
});
