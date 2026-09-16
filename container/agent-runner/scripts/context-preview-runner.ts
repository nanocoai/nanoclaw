/**
 * Bun half of the context-preview tool. Never run directly — spawned by
 * `scripts/context-preview.ts` (host side), which stages a session (inbound.db
 * + outbound.db) in a sandbox and passes a spec file describing where.
 *
 * Reproduces the container-side context assembly with the REAL production
 * code paths — no agent-visible string is duplicated. The tool-module list
 * is read from the MCP barrel (mcp-tools/index.ts) at run time, so an
 * installed or removed tool module is reflected without editing this file;
 * one piece of WIRING is mirrored from src/index.ts main() (commented at its
 * use site): the mcpServers/cwd assembly.
 *   - `runnerConfigFromRaw()` parses the staged container.json exactly as
 *     `loadConfig()` does; `setTestConfig()` installs it.
 *   - `initTestSessionDb()` swaps the /workspace/*.db singletons for
 *     in-memory DBs; the staged rows are copied in byte-identical.
 *   - `runPollLoop()` (the real loop) runs against a capturing provider, so
 *     batching, on_wake first-poll gating, the accumulate gate, and slash
 *     command splitting are exactly what a real container does.
 *   - `buildSystemPromptAddendum()` renders the runtime system-prompt
 *     addendum from the staged destinations table + session routing (task
 *     mode is derived from the routing thread, as in production).
 *   - `createProvider('claude')` + `ClaudeProvider.buildQueryOptions()`
 *     render the exact SDK options, contract-resolved like production.
 *   - `listRegisteredTools()` renders the nanoclaw MCP tool surface.
 *
 * Emits one JSON object on stdout; all logging goes to stderr.
 */
import { Database } from 'bun:sqlite';
import fs from 'fs';

import { runnerConfigFromRaw, setTestConfig } from '../src/config.js';
import { buildSystemPromptAddendum } from '../src/destinations.js';
import { getTaskSeriesId } from '../src/db/session-routing.js';
import { initTestSessionDb } from '../src/mailbox/sqlite/connection.js';
import { MEMORY_SESSION_HOOK } from '../src/memory/session-hook.js';
// Module barrel — registers the singular mailbox slot (same as index.ts).
import '../src/modules/index.js';
import { listRegisteredTools } from '../src/mcp-tools/server.js';
import { resolvePluginServer } from '../src/plugin-mcp.js';
import { runPollLoop } from '../src/poll-loop.js';
import { registerProviderMemorySessionHook } from '../src/provider-contracts/realize.js';
// Providers + contracts barrels — each provider self-registers (same as index.ts).
import '../src/providers/index.js';
import '../src/provider-contracts/index.js';
import type { ClaudeProvider } from '../src/providers/claude.js';
import { createProvider } from '../src/providers/factory.js';
import { getProviderRuntimeContract } from '../src/providers/provider-registry.js';
import type { AgentProvider, AgentQuery, McpServerConfig, ProviderEvent, QueryInput } from '../src/providers/types.js';

interface PreviewSpec {
  inboundDbPath: string;
  outboundDbPath: string;
  /** Parsed groups/<folder>/container.json, as materialized by the host. */
  containerConfig: Record<string, unknown>;
  /** Container paths of /workspace/extra/* mounts — what index.ts would
   *  discover by scanning that directory in a real container. */
  additionalDirectories?: string[];
}

function log(msg: string): void {
  console.error(`[context-preview-runner] ${msg}`);
}

/**
 * Load every tool module the MCP barrel loads, in barrel order, so the
 * registered tool surface is exactly the server's. The barrel itself cannot
 * be imported (it starts the MCP server on import), so its side-effect
 * import lines are read from the file — the one list, no mirror.
 */
async function loadToolModulesFromBarrel(): Promise<string[]> {
  const barrel = new URL('../src/mcp-tools/index.ts', import.meta.url);
  const source = await Bun.file(barrel).text();
  const specifiers = [...source.matchAll(/^import '(\.[^']+)';/gm)].map((m) => m[1]);
  for (const spec of specifiers) await import(new URL(spec, barrel).href);
  return specifiers;
}

/** Copy all rows of `table` between DBs, matching columns by name. */
function copyTable(src: Database, dst: Database, table: string): number {
  const exists = src.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
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
 * the turn like a provider would. Slash-command splitting and mid-turn text
 * delivery come from the previewed provider's runtime contract (passed to
 * runPollLoop as `providerContract`, as index.ts does); the legacy instance
 * flag below only matters for a contractless provider.
 */
class CapturingProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  captured: QueryInput[] = [];
  onCapture: () => void = () => {};

  registerMemorySessionHook(): void {}

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
      // harness env, so render only what the provider itself set or changed.
      const env = value as Record<string, string | undefined>;
      out.env = Object.fromEntries(Object.entries(env).filter(([k, v]) => process.env[k] !== v));
      out.envNote =
        'Remaining env inherited from the container process (TZ + OneCLI proxy vars; see src/container-runner.ts buildContainerArgs).';
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

  log(`Tool modules from barrel: ${(await loadToolModulesFromBarrel()).join(', ')}`);

  // Same parse as loadConfig() — defaults included.
  const config = runnerConfigFromRaw(spec.containerConfig);
  setTestConfig(config);

  // In-memory session DBs seeded from the staged files. The test schema is
  // the poll-loop tests' one; add the two host-written pieces the preview
  // reads (session routing → task mode; a2a return path).
  const { inbound, outbound } = initTestSessionDb();
  inbound.exec(`
    CREATE TABLE IF NOT EXISTS session_routing (
      id INTEGER PRIMARY KEY CHECK (id = 1), channel_type TEXT, platform_id TEXT, thread_id TEXT
    );
    ALTER TABLE messages_in ADD COLUMN source_session_id TEXT;
  `);
  const stagedInbound = new Database(spec.inboundDbPath, { readonly: true });
  const stagedOutbound = new Database(spec.outboundDbPath, { readonly: true });
  const nIn = copyTable(stagedInbound, inbound, 'messages_in');
  copyTable(stagedInbound, inbound, 'destinations');
  copyTable(stagedInbound, inbound, 'session_routing');
  copyTable(stagedOutbound, outbound, 'session_state');
  copyTable(stagedOutbound, outbound, 'processing_ack');
  stagedInbound.close();
  stagedOutbound.close();
  log(`Seeded ${nIn} messages_in rows from staged session`);

  // Same assembly as index.ts main(). In the container, index.ts resolves the
  // MCP server path from its own location under /app/src — render that truth,
  // not this script's host location.
  const taskId = getTaskSeriesId();
  const instructions = buildSystemPromptAddendum(
    config.assistantName || undefined,
    taskId ? { kind: 'task', taskId } : { kind: 'chat' },
  );
  const cwd = '/workspace/agent';
  const mcpServers: Record<string, McpServerConfig> = {
    nanoclaw: { command: 'bun', args: ['run', '/app/src/mcp-tools/index.ts'], env: {} },
  };
  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    mcpServers[name] = resolvePluginServer(serverConfig);
  }

  // Drive the real poll loop until the first query is captured. Scenarios
  // with no wake-eligible rows (e.g. subagent) skip the loop — it would
  // never query (the accumulate gate holds trigger=0-only batches).
  const provider = new CapturingProvider();
  const hasWakeEligible =
    (
      inbound.prepare("SELECT COUNT(*) AS n FROM messages_in WHERE status = 'pending' AND trigger = 1").get() as {
        n: number;
      }
    ).n > 0;
  if (hasWakeEligible) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    provider.onCapture = () => controller.abort();
    await runPollLoop({
      provider,
      providerContract: getProviderRuntimeContract(config.provider),
      providerName: config.provider,
      cwd,
      systemContext: { instructions },
      signal: controller.signal,
    });
    clearTimeout(timeout);
  }

  const captured = provider.captured[0] ?? null;

  // The exact SDK options ClaudeProvider would run this query with — built
  // through createProvider so the contract resolves execution policy,
  // inference, and MCP servers exactly as index.ts does.
  let sdkOptions: Record<string, unknown> | null = null;
  if (config.provider === 'claude') {
    const claude = createProvider('claude', {
      assistantName: config.assistantName || undefined,
      mcpServers,
      env: { ...process.env },
      additionalDirectories: spec.additionalDirectories?.length ? spec.additionalDirectories : undefined,
      model: config.model,
      effort: config.effort,
      speed: config.speed,
    }) as ClaudeProvider;
    registerProviderMemorySessionHook('claude', claude, MEMORY_SESSION_HOOK);
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
    .prepare(
      'SELECT id, seq, kind, timestamp, status, trigger, on_wake, channel_type, platform_id FROM messages_in ORDER BY seq',
    )
    .all();

  process.stdout.write(
    JSON.stringify(
      {
        captured: captured !== null,
        prompt: captured?.prompt ?? null,
        continuation: captured?.continuation ?? null,
        systemPromptAddendum: instructions,
        sessionMode: taskId ? { kind: 'task', taskId } : { kind: 'chat' },
        sdkOptions,
        mcpTools: listRegisteredTools().map((t) => ({
          name: t.tool.name,
          description: t.tool.description,
          inputSchema: t.tool.inputSchema,
        })),
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
