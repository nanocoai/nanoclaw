import { getAllSessions, getSession, getSessionsByAgentGroup } from '../../db/sessions.js';
import {
  formatHistoryLines,
  HISTORY_DEFAULT_LIMIT,
  sessionHistory,
  type HistoryRow,
} from '../../modules/cross-session-context/index.js';
import type { MailboxUsageTurn } from '../../mailbox/types.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { registerResource } from '../crud.js';
import {
  formatGroupTable,
  formatPromptTable,
  formatUsageTable,
  type PromptUsageReport,
  type PromptUsageRow,
  type UsageGroupReport,
  type UsageGroupRow,
  type UsageReport,
  type UsageRow,
} from '../format-usage.js';
import type { CallerContext } from '../frame.js';

/**
 * The state key the container's poll loop accumulates its per-turn token
 * totals under. Mirrored here rather than imported: host and container share
 * no modules, only the mailbox.
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
 * started, mailbox gone, nothing ever banked under the key, value unparseable.
 * They are deliberately not distinguished: the caller reports them as
 * unmeasured, and none of them means the session was free.
 */
async function readSessionUsage(agentGroupId: string, sessionId: string): Promise<UsageRow | null> {
  let raw: string | undefined;
  try {
    raw = await withExistingMailboxSession(agentGroupId, sessionId, (mailbox) => mailbox.getState(USAGE_KEY)?.value);
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
async function selectedSessions(
  args: Record<string, unknown>,
  ctx: CallerContext,
): Promise<{ id: string; group: string }[]> {
  const sessionId = typeof args.session === 'string' ? args.session : undefined;
  if (sessionId) {
    const session = await getSession(sessionId);
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

  const sessions = group ? await getSessionsByAgentGroup(group) : await getAllSessions();
  return sessions.map((s) => ({ id: s.id, group: s.agent_group_id }));
}

async function sessionsUsage(args: Record<string, unknown>, ctx: CallerContext): Promise<UsageReport> {
  const rows: UsageRow[] = [];
  let unreported = 0;
  for (const { id, group } of await selectedSessions(args, ctx)) {
    const usage = await readSessionUsage(group, id);
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

/** A number the provider actually reported, or null. */
function measured(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * One session's per-turn ledger, newest first. Empty covers every way a
 * session can have no detail on file — never started, mailbox gone, mailbox
 * older than the ledger, ledger unreadable.
 */
async function readSessionTurns(agentGroupId: string, sessionId: string, limit?: number): Promise<PromptUsageRow[]> {
  let rows: MailboxUsageTurn[] | undefined;
  try {
    rows = await withExistingMailboxSession(agentGroupId, sessionId, (mailbox) => mailbox.getUsageLog(limit));
  } catch {
    return [];
  }

  return (rows ?? []).map((r) => {
    const input = measured(r.inputTokens);
    const output = measured(r.outputTokens);
    const cacheRead = measured(r.cacheReadTokens);
    const cacheCreation = measured(r.cacheCreationTokens);
    const parts = [input, output, cacheRead, cacheCreation].filter((v): v is number => v !== null);
    return {
      session_id: sessionId,
      agent_group_id: agentGroupId,
      timestamp: typeof r.timestamp === 'string' ? r.timestamp : '',
      task_series_id: r.taskSeriesId ?? null,
      prompt_preview: typeof r.promptPreview === 'string' ? r.promptPreview : '',
      prompt_chars: measured(r.promptChars) ?? 0,
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: cacheRead,
      cache_creation_tokens: cacheCreation,
      // Null, not zero, when the turn went entirely unmeasured.
      total_tokens: parts.length ? parts.reduce((a, b) => a + b, 0) : null,
      cost_usd: measured(r.costUsd),
    };
  });
}

const EMPTY_GROUP = {
  sessions: 0,
  turns: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  total_tokens: 0,
  cost_usd: 0,
};

function addInto(acc: Omit<UsageGroupRow, 'key'>, r: Omit<UsageGroupRow, 'key' | 'sessions'>): void {
  acc.turns += r.turns;
  acc.input_tokens += r.input_tokens;
  acc.output_tokens += r.output_tokens;
  acc.cache_read_tokens += r.cache_read_tokens;
  acc.cache_creation_tokens += r.cache_creation_tokens;
  acc.total_tokens += r.total_tokens;
  acc.cost_usd = roundCost(acc.cost_usd + r.cost_usd);
}

/**
 * `sessions` is passed rather than summed off the rows: task keys are not
 * disjoint the way agent keys are — one session runs many series and appears
 * under each — so adding the column up counts it once per series it ran.
 */
function summarize(
  groups: Map<string, Omit<UsageGroupRow, 'key'>>,
  by: 'agent' | 'task',
  unmeasured: number,
  sessions: number,
): UsageGroupReport {
  const rows: UsageGroupRow[] = [...groups].map(([key, g]) => ({ key, ...g }));
  rows.sort((a, b) => b.total_tokens - a.total_tokens || a.key.localeCompare(b.key));
  const totals = { ...EMPTY_GROUP, sessions };
  for (const r of rows) addInto(totals, r);
  return { by, groups: rows, totals, unmeasured };
}

/**
 * Per agent group, from the lifetime totals each session banked — not from the
 * ledger, which only retains recent turns.
 */
async function usageByAgent(args: Record<string, unknown>, ctx: CallerContext): Promise<UsageGroupReport> {
  const groups = new Map<string, Omit<UsageGroupRow, 'key'>>();
  let unmeasured = 0;
  let sessions = 0;
  for (const { id, group } of await selectedSessions(args, ctx)) {
    const usage = await readSessionUsage(group, id);
    if (!usage) {
      unmeasured += 1;
      continue;
    }
    const acc = groups.get(group) ?? { ...EMPTY_GROUP };
    addInto(acc, usage);
    acc.sessions += 1;
    sessions += 1;
    groups.set(group, acc);
  }
  return summarize(groups, 'agent', unmeasured, sessions);
}

/**
 * Per task series, from the ledger — the only place the series is recorded.
 * Turns that belong to no task collect under `(chat)`.
 */
async function usageByTask(args: Record<string, unknown>, ctx: CallerContext): Promise<UsageGroupReport> {
  const groups = new Map<string, Omit<UsageGroupRow, 'key'>>();
  const seen = new Map<string, Set<string>>();
  const measuredSessions = new Set<string>();
  let unmeasured = 0;
  for (const { id, group } of await selectedSessions(args, ctx)) {
    for (const turn of await readSessionTurns(group, id)) {
      if (turn.total_tokens === null && turn.cost_usd === null) {
        // Counted apart, as `--by prompt` does and as the table's footnote
        // promises — summed in as a zero it would read as a free turn.
        unmeasured += 1;
        continue;
      }
      measuredSessions.add(id);
      const key = turn.task_series_id ?? '(chat)';
      const acc = groups.get(key) ?? { ...EMPTY_GROUP };
      addInto(acc, {
        turns: 1,
        input_tokens: turn.input_tokens ?? 0,
        output_tokens: turn.output_tokens ?? 0,
        cache_read_tokens: turn.cache_read_tokens ?? 0,
        cache_creation_tokens: turn.cache_creation_tokens ?? 0,
        total_tokens: turn.total_tokens ?? 0,
        cost_usd: turn.cost_usd ?? 0,
      });
      const sessions = seen.get(key) ?? new Set<string>();
      sessions.add(id);
      seen.set(key, sessions);
      acc.sessions = sessions.size;
      groups.set(key, acc);
    }
  }
  return summarize(groups, 'task', unmeasured, measuredSessions.size);
}

/** Newest turns first, one row per prompt. */
const PROMPT_LIMIT_DEFAULT = 20;
/**
 * Ceiling on `--limit`. The limit decides how much of each session's ledger is
 * read, not only how much is printed, so an unbounded one asks every session
 * in the fleet for everything it retains — and `ncl` gives a call 30 seconds.
 */
export const PROMPT_LIMIT_MAX = 500;

async function usageByPrompt(args: Record<string, unknown>, ctx: CallerContext): Promise<PromptUsageReport> {
  const limitArg = Number(args.limit);
  const asked = Number.isFinite(limitArg) && limitArg > 0 ? Math.floor(limitArg) : PROMPT_LIMIT_DEFAULT;
  const limit = Math.min(asked, PROMPT_LIMIT_MAX);

  // Read each session newest-first up to the limit, then merge: the newest N
  // overall are always among each session's newest N, so this bounds the work
  // without changing the answer.
  const turns: PromptUsageRow[] = [];
  for (const { id, group } of await selectedSessions(args, ctx))
    turns.push(...(await readSessionTurns(group, id, limit)));
  turns.sort((a, b) => b.timestamp.localeCompare(a.timestamp) || a.session_id.localeCompare(b.session_id));
  const prompts = turns.slice(0, limit);

  const totals = {
    turns: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
  };
  let unmeasured = 0;
  for (const p of prompts) {
    if (p.total_tokens === null && p.cost_usd === null) {
      // Counted apart rather than summed as zero — the turn ran, unmeasured.
      unmeasured += 1;
      continue;
    }
    totals.turns += 1;
    totals.input_tokens += p.input_tokens ?? 0;
    totals.output_tokens += p.output_tokens ?? 0;
    totals.cache_read_tokens += p.cache_read_tokens ?? 0;
    totals.cache_creation_tokens += p.cache_creation_tokens ?? 0;
    totals.total_tokens += p.total_tokens ?? 0;
    totals.cost_usd = roundCost(totals.cost_usd + (p.cost_usd ?? 0));
  }

  return { by: 'prompt', prompts, totals, unmeasured };
}

const GROUPINGS = ['session', 'agent', 'task', 'prompt'] as const;
type Grouping = (typeof GROUPINGS)[number];

function grouping(args: Record<string, unknown>): Grouping {
  const by = args.by;
  if (by === undefined || by === null || by === '') return 'session';
  if (typeof by !== 'string' || !(GROUPINGS as readonly string[]).includes(by)) {
    throw new Error(`unknown grouping: ${String(by)} (expected one of ${GROUPINGS.join(', ')})`);
  }
  return by as Grouping;
}

type AnyUsageReport = UsageReport | UsageGroupReport | PromptUsageReport;

async function usageReport(args: Record<string, unknown>, ctx: CallerContext): Promise<AnyUsageReport> {
  switch (grouping(args)) {
    case 'agent':
      return usageByAgent(args, ctx);
    case 'task':
      return usageByTask(args, ctx);
    case 'prompt':
      return usageByPrompt(args, ctx);
    default:
      return sessionsUsage(args, ctx);
  }
}

function formatUsage(data: AnyUsageReport): string {
  if ('prompts' in data) return formatPromptTable(data);
  if ('groups' in data) return formatGroupTable(data);
  return formatUsageTable(data);
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
        'Token and cost totals, as the provider reported them.\n\n' +
        "Read from each session's mailbox, where the container banks one turn at a time, so the numbers survive container restarts and cover closed sessions too. Only providers that report usage contribute; whatever went unmeasured is counted separately rather than shown as zero, because unmeasured is not the same as free.\n\n" +
        "--by session (default) and --by agent come from each session's lifetime totals. --by task and --by prompt come from the per-turn ledger, which keeps a fixed recent window rather than all history, so prompts older than that age out of those two views while the totals stay complete.\n\n" +
        'Prompts are stored as a clipped preview — enough to recognise the turn, not a second copy of the conversation.\n\n' +
        'Host callers see every group by default; inside a container the report is always your own group.',
      args: [
        {
          name: 'by',
          type: 'string',
          description: 'Grouping: session (default), agent, task, or prompt.',
          enum: [...GROUPINGS],
        },
        {
          name: 'group',
          type: 'string',
          description: 'Agent group id (host callers; always your own group inside a container).',
        },
        { name: 'session', type: 'string', description: 'Limit to one session id.' },
        {
          name: 'limit',
          type: 'number',
          description: `Prompts to list with --by prompt (default ${PROMPT_LIMIT_DEFAULT}, capped at ${PROMPT_LIMIT_MAX}).`,
        },
      ],
      examples: [
        'ncl sessions usage',
        'ncl sessions usage --by agent',
        'ncl sessions usage --by task',
        'ncl sessions usage --by prompt --limit 50',
        'ncl sessions usage --session sess-abc',
      ],
      handler: async (args, ctx) => usageReport(args, ctx),
      formatHuman: (data) => formatUsage(data as AnyUsageReport),
    },
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
