/**
 * Bun half of the context-preview tool. Never run directly — spawned by
 * `scripts/context-preview.ts` (host side), which stages a session (inbound.db
 * + outbound.db) in a sandbox and passes a spec file describing where.
 *
 * Reproduces the container-side context assembly with the REAL production
 * code paths — no agent-visible string is duplicated. Two pieces of WIRING
 * are mirrored from src (kept small and commented at their use sites): the
 * tool-module import list from mcp-tools/index.ts and the mcpServers/cwd
 * assembly from index.ts main().
 *   - `initTestSessionDb()` swaps the /workspace/*.db singletons for
 *     in-memory DBs; the staged rows are copied in byte-identical.
 *   - `runPollLoop()` (the real loop) runs against a capturing provider, so
 *     batching, on_wake first-poll gating, the accumulate gate, and slash
 *     command splitting are exactly what a real container does.
 *   - `buildSystemPromptAddendum()` renders the runtime system-prompt
 *     addendum from the staged destinations table.
 *   - `ClaudeProvider.buildQueryOptions()` renders the exact SDK options.
 *   - `listRegisteredTools()` renders the nanoclaw MCP tool surface.
 *
 * Emits one JSON object on stdout; all logging goes to stderr.
 */
import { Database } from 'bun:sqlite';
import fs from 'fs';

import { setTestConfig, type RunnerConfig } from '../src/config.js';
import { initTestSessionDb } from '../src/db/connection.js';
import { buildSystemPromptAddendum } from '../src/destinations.js';
// Tool modules self-register on import — same set the MCP barrel loads.
import '../src/mcp-tools/core.js';
import '../src/mcp-tools/interactive.js';
import '../src/mcp-tools/agents.js';
import '../src/mcp-tools/self-mod.js';
import { listRegisteredTools } from '../src/mcp-tools/server.js';
import { runPollLoop } from '../src/poll-loop.js';
import { ClaudeProvider } from '../src/providers/claude.js';
import type { AgentProvider, AgentQuery, ProviderEvent, QueryInput } from '../src/providers/types.js';

interface PreviewSpec {
  inboundDbPath: string;
  outboundDbPath: string;
  containerConfig: Partial<RunnerConfig>;
  /** Container paths of /workspace/extra/* mounts — what index.ts would
   *  discover by scanning that directory in a real container. */
  additionalDirectories?: string[];
}

function log(msg: string): void {
  console.error(`[context-preview-runner] ${msg}`);
}

/** Copy all rows of `table` between DBs, matching columns by name. */
function copyTable(src: Database, dst: Database, table: string): number {
  const exists = src
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (!exists) return 0;
  const dstCols = new Set(
    (dst.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map((c) => c.name),
  );
  const rows = src.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
  for (const row of rows) {
    const cols = Object.keys(row).filter((c) => dstCols.has(c));
    dst
      .prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...cols.map((c) => row[c] as never));
  }
  return rows.length;
}

/**
 * Records the QueryInput the poll loop hands the provider, then completes
 * the turn like a provider would. supportsNativeSlashCommands mirrors the
 * previewed provider (Claude handles slash commands natively; other
 * providers get the XML-wrapped form) so command splitting matches.
 */
class CapturingProvider implements AgentProvider {
  readonly supportsNativeSlashCommands: boolean;
  captured: QueryInput[] = [];
  onCapture: () => void = () => {};

  constructor(nativeSlashCommands: boolean) {
    this.supportsNativeSlashCommands = nativeSlashCommands;
  }

  isSessionInvalid(): boolean {
    return false;
  }

  query(input: QueryInput): AgentQuery {
    this.captured.push(input);
    const notify = this.onCapture;
    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'activity' };
        // Null text completes the turn without dispatch (and without the
        // re-wrap nudge); ending the stream lets processQuery return, after
        // which the abort signal stops the outer loop.
        yield { type: 'result', text: null };
        notify();
      },
    };
    return { push: () => {}, end: () => {}, abort: () => {}, events };
  }
}

/** JSON-safe copy of the SDK options: functions → descriptive placeholders. */
function sanitizeSdkOptions(options: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (key === 'hooks' && value && typeof value === 'object') {
      out.hooks = Object.keys(value);
    } else if (key === 'mcpServers' && value && typeof value === 'object') {
      // Per-server env can carry credentials from a live container config —
      // never print the values.
      out.mcpServers = Object.fromEntries(
        Object.entries(value as Record<string, { env?: Record<string, string> }>).map(([name, server]) => [
          name,
          {
            ...server,
            env: Object.fromEntries(Object.keys(server.env ?? {}).map((k) => [k, '<redacted>'])),
          },
        ]),
      );
    } else if (key === 'env' && value && typeof value === 'object') {
      // Env is inherited from the real container process; here it's the
      // harness env, so render only the keys the provider itself sets.
      out.env = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: (value as Record<string, unknown>).CLAUDE_CODE_AUTO_COMPACT_WINDOW };
      out.envNote = 'Remaining env inherited from the container process (TZ + OneCLI proxy vars; see src/container-runner.ts buildContainerArgs).';
    } else if (typeof value === 'function') {
      out[key] = '<function>';
    } else {
      out[key] = value;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const specPath = process.argv[2];
  if (!specPath) {
    console.error('Usage: bun context-preview-runner.ts <spec.json>');
    process.exit(2);
  }
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8')) as PreviewSpec;

  const raw = spec.containerConfig;
  const config: RunnerConfig = {
    provider: raw.provider || 'claude',
    assistantName: raw.assistantName || '',
    groupName: raw.groupName || '',
    agentGroupId: raw.agentGroupId || '',
    maxMessagesPerPrompt: raw.maxMessagesPerPrompt || 10,
    mcpServers: raw.mcpServers || {},
    model: raw.model,
    effort: raw.effort,
  };
  setTestConfig(config);

  // In-memory session DBs seeded from the staged files.
  const { inbound, outbound } = initTestSessionDb();
  const stagedInbound = new Database(spec.inboundDbPath, { readonly: true });
  const stagedOutbound = new Database(spec.outboundDbPath, { readonly: true });
  const nIn = copyTable(stagedInbound, inbound, 'messages_in');
  copyTable(stagedInbound, inbound, 'destinations');
  copyTable(stagedOutbound, outbound, 'session_state');
  copyTable(stagedOutbound, outbound, 'processing_ack');
  stagedInbound.close();
  stagedOutbound.close();
  log(`Seeded ${nIn} messages_in rows from staged session`);

  // Same assembly as index.ts main(). In the container, index.ts resolves the
  // MCP server path from its own location under /app/src — render that truth,
  // not this script's host location.
  const instructions = buildSystemPromptAddendum(config.assistantName || undefined);
  const cwd = '/workspace/agent';
  const mcpServerPath = '/app/src/mcp-tools/index.ts';
  const mcpServers: RunnerConfig['mcpServers'] = {
    nanoclaw: { command: 'bun', args: ['run', mcpServerPath], env: {} },
    ...config.mcpServers,
  };

  // Drive the real poll loop until the first query is captured. Scenarios
  // with no wake-eligible rows (e.g. subagent) skip the loop — it would
  // never query (the accumulate gate holds trigger=0-only batches).
  const provider = new CapturingProvider(config.provider === 'claude');
  const hasWakeEligible =
    (inbound.prepare("SELECT COUNT(*) AS n FROM messages_in WHERE status = 'pending' AND trigger = 1").get() as { n: number }).n > 0;
  if (hasWakeEligible) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    provider.onCapture = () => controller.abort();
    await runPollLoop({
      provider,
      providerName: config.provider,
      cwd,
      systemContext: { instructions },
      signal: controller.signal,
    });
    clearTimeout(timeout);
  }

  const captured = provider.captured[0] ?? null;

  // The exact SDK options ClaudeProvider would run this query with.
  let sdkOptions: Record<string, unknown> | null = null;
  if (config.provider === 'claude') {
    const claude = new ClaudeProvider({
      assistantName: config.assistantName || undefined,
      mcpServers,
      env: { ...process.env },
      additionalDirectories: spec.additionalDirectories?.length ? spec.additionalDirectories : undefined,
      model: config.model,
      effort: config.effort,
    });
    sdkOptions = sanitizeSdkOptions(
      claude.buildQueryOptions({
        prompt: captured?.prompt ?? '',
        continuation: captured?.continuation,
        cwd,
        systemContext: { instructions },
      }) as unknown as Record<string, unknown>,
    );
  }

  const batch = inbound
    .prepare('SELECT id, seq, kind, timestamp, status, trigger, on_wake, channel_type, platform_id FROM messages_in ORDER BY seq')
    .all();

  process.stdout.write(
    JSON.stringify(
      {
        captured: captured !== null,
        prompt: captured?.prompt ?? null,
        continuation: captured?.continuation ?? null,
        systemPromptAddendum: instructions,
        sdkOptions,
        mcpTools: listRegisteredTools().map((t) => ({ name: t.tool.name, description: t.tool.description })),
        provider: config.provider,
        batch,
      },
      null,
      2,
    ) + '\n',
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(`[context-preview-runner] Fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
