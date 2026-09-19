/**
 * MCP → pi tool bridge.
 *
 * pi has no native MCP subsystem (by design — tools are extended via
 * `customTools`). This bridge takes the MCP server configs from the v2
 * provider contract (`McpServerConfig`) and turns them into
 * `ToolDefinition[]` that can be fed straight into
 * `createAgentSession({ customTools })`.
 *
 * Lifecycle (see docs/mcp-to-pi-design.md §3.3):
 * - Per-process, long-lived. Built lazily on first query, reused across
 *   queries/sessions via `getPiMcpTools`; disposed on process exit.
 * - A single broken server is skipped (logged) — it must not take down the
 *   provider or the system tools living on the built-in `nanoclaw` server.
 * - An unhealthy server is lazily reconnected once on the next tool call.
 * - `abort()` only cancels in-flight `callTool` requests (via the execute
 *   `signal`); it never closes servers — the abort applies to one reasoning
 *   turn, not to the MCP services themselves.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  type StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

import type { McpServerConfig } from './types.js';

/** Per-request timeout handed to `client.callTool`. MCP SDK's own default (60s) is tight for slow servers. */
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
/** Short timeout for connect + each listTools page so one stuck server cannot stall the first query (design §5 R9). */
const CONNECT_TIMEOUT_MS = 15_000;
/** Hard cap per returned text block, defensively keeping huge tool outputs out of the transcript (design §5 R1). */
const DEFAULT_MAX_TEXT_CHARS = 100_000;

/** Subset of pi's tool-result content shapes this bridge can produce (text/image only — see design §3.5). */
export type PiContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface McpBridgeOptions {
  /** Timeout for a single tools/call, ms. Default 120_000. */
  callTimeoutMs?: number;
  /** pi execution mode for bridged tools. Default "sequential" (MCP tools may have side effects). */
  executionMode?: 'sequential' | 'parallel';
  /** Max characters per returned text block. Default 100_000. */
  maxTextChars?: number;
  logger?: (msg: string) => void;
}

export interface McpBridgeHandle {
  /** Feed directly into `createAgentSession({ customTools })`. */
  tools: ToolDefinition[];
  /** Close every server connection (stdio → kills child process, http → ends session). Swallows errors. */
  dispose(): Promise<void>;
}

/**
 * Minimal connection surface `wrapMcpTool` needs. `McpServerConnection`
 * implements it with lazy reconnect; tests can stub it over an in-memory
 * transport.
 */
export interface McpConnection {
  /** Server name (tool-name prefix + log context only; not part of the MCP protocol). */
  readonly name: string;
  /** Return a healthy client; reconnect once when unhealthy, throw (with server name) on failure. */
  ensureClient(): Promise<Client>;
}

// ---------------------------------------------------------------------------
// ① Shape translation (pure, unit-testable)
// ---------------------------------------------------------------------------

const NAME_INVALID = /[^A-Za-z0-9_-]/g;

/**
 * `mcp__<server>__<tool>` with every char outside `[A-Za-z0-9_-]` folded to
 * `_`. The prefix matches the Claude Code convention and cannot collide with
 * pi built-ins or the runner's own custom tools.
 */
export function sanitizeToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName.replace(NAME_INVALID, '_')}__${toolName.replace(NAME_INVALID, '_')}`;
}

/** Assigns unique tool names across the whole bridge; renames (with a log line) on sanitize collisions (design §5 R8). */
export function createToolNamer(
  log: (msg: string) => void,
): (serverName: string, toolName: string) => string {
  const used = new Set<string>();
  return (serverName, toolName) => {
    const base = sanitizeToolName(serverName, toolName);
    let name = base;
    let n = 2;
    while (used.has(name)) name = `${base}_${n++}`;
    if (name !== base) log(`MCP tool name "${base}" conflicts with an earlier tool, renamed to "${name}"`);
    used.add(name);
    return name;
  };
}

/**
 * `McpServerConfig` (stdio branch) → `StdioServerParameters`.
 *
 * - `env: {}` is omitted so the SDK's `getDefaultEnvironment()` applies (a
 *   literally empty env would leave the child without PATH — design §5 R6;
 *   the built-in nanoclaw server stamps `env: {}`).
 * - `cwd` passes through natively; the opencode cwd-shim is not needed here
 *   because the MCP SDK has a real spawn-directory field.
 * - `pluginRoot` is consumed by plugin-mcp.ts before configs reach a
 *   provider; ignored here defensively.
 */
export function toStdioServerParameters(
  cfg: Extract<McpServerConfig, { type?: 'stdio' }>,
): StdioServerParameters {
  const params: StdioServerParameters = { command: cfg.command, args: cfg.args ?? [] };
  if (cfg.env && Object.keys(cfg.env).length > 0) params.env = cfg.env;
  if (cfg.cwd) params.cwd = cfg.cwd;
  return params;
}

function truncateText(text: string, max: number): string {
  if (!Number.isFinite(max) || max <= 0 || text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated]`;
}

/**
 * MCP `CallToolResult.content` → pi content blocks (design §3.5).
 * text/image pass through; audio and binary resource blobs degrade to text
 * placeholders (pi only supports text/image tool results); a text resource
 * passes through its text; `structuredContent` is appended as a
 * JSON-serialized text block. Every text block is truncated to
 * `maxTextChars`.
 */
export function mapContentBlocks(
  result: CallToolResult,
  opts: McpBridgeOptions = {},
): PiContentBlock[] {
  const max = opts.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
  const out: PiContentBlock[] = [];

  for (const block of result.content ?? []) {
    switch (block.type) {
      case 'text':
        out.push({ type: 'text', text: truncateText(block.text ?? '', max) });
        break;
      case 'image':
        out.push({
          type: 'image',
          data: block.data ?? '',
          mimeType: block.mimeType ?? 'image/png',
        });
        break;
      case 'audio':
        out.push({
          type: 'text',
          text: `[audio: ${block.mimeType ?? 'unknown'}, ${block.data?.length ?? 0} base64 chars — audio tool results are not supported; ask the user to save the file if needed]`,
        });
        break;
      case 'resource_link':
        out.push({
          type: 'text',
          text: `resource: ${block.uri}${block.name ? ` (${block.name})` : ''}`,
        });
        break;
      case 'resource': {
        const r = block.resource;
        if (r && 'text' in r) {
          out.push({ type: 'text', text: truncateText(r.text, max) });
        } else {
          out.push({
            type: 'text',
            text: `[resource ${r?.uri ?? ''}: ${r?.mimeType ?? 'unknown'}, ${r && 'blob' in r ? r.blob.length : 0} base64 chars — binary resource results are not supported; ask the user to save the file if needed]`,
          });
        }
        break;
      }
      default:
        // Unknown future content type — skip defensively rather than break the tool result.
        break;
    }
  }

  if (result.structuredContent !== undefined) {
    out.push({ type: 'text', text: truncateText(JSON.stringify(result.structuredContent), max) });
  }

  return out;
}

function errorText(result: CallToolResult, toolName: string): string {
  const text = (result.content ?? [])
    .map((b) => (b.type === 'text' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
  return text || `MCP tool ${toolName} failed`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// ② Server connection layer
// ---------------------------------------------------------------------------

class McpServerConnection implements McpConnection {
  readonly name: string;
  private client: Client | null = null;
  private healthy = false;
  private readonly cfg: McpServerConfig;
  private readonly log: (msg: string) => void;

  constructor(name: string, cfg: McpServerConfig, log: (msg: string) => void) {
    this.name = name;
    this.cfg = cfg;
    this.log = log;
  }

  /** Initial connect + full paginated tool listing. Throws on failure (facade degrades to skip). */
  async connectAndListTools(): Promise<Tool[]> {
    const client = await this.spawnClient();
    const tools = await this.listAllTools(client);
    this.client = client;
    this.healthy = true;
    return tools;
  }

  async ensureClient(): Promise<Client> {
    if (this.client && this.healthy) return this.client;
    // Unhealthy (crashed child / dropped http session) → lazy reconnect once.
    // Never triggered by abort(): the execute signal only cancels the
    // in-flight request; servers outlive individual turns (design §5 R3).
    this.log(`MCP server "${this.name}" unhealthy, reconnecting once`);
    await this.closeClient();
    await this.connectAndListTools(); // relist once after reconnect (design §3.3)
    if (!this.client) throw new Error(`MCP server "${this.name}" failed to reconnect`);
    return this.client;
  }

  async close(): Promise<void> {
    await this.closeClient();
  }

  private async spawnClient(): Promise<Client> {
    const client = new Client({ name: 'nanoclaw-pi-bridge', version: '1.0.0' });
    client.onclose = () => {
      this.healthy = false;
    };
    client.onerror = (err) => {
      this.log(`MCP server "${this.name}" transport error: ${errMsg(err)}`);
    };
    try {
      // `connect()` takes no RequestOptions in the pinned SDK line, so the
      // connect-phase timeout lives here (design §5 R9).
      await withTimeout(
        client.connect(this.buildTransport()),
        CONNECT_TIMEOUT_MS,
        `connect to MCP server "${this.name}"`,
      );
    } catch (err) {
      await this.quietClose(client);
      throw err;
    }
    return client;
  }

  private buildTransport(): StdioClientTransport | StreamableHTTPClientTransport {
    const cfg = this.cfg;
    if (cfg.type === 'http') {
      // Streamable HTTP only — no legacy SSE fallback on purpose (design §3.6).
      // Headers pass through untouched (OneCLI trust model: placeholders at most).
      const requestInit: RequestInit = {};
      if (cfg.headers && Object.keys(cfg.headers).length > 0) requestInit.headers = cfg.headers;
      return new StreamableHTTPClientTransport(
        new URL(cfg.url),
        requestInit.headers ? { requestInit } : undefined,
      );
    }
    return new StdioClientTransport(toStdioServerParameters(cfg));
  }

  private async listAllTools(client: Client): Promise<Tool[]> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await withTimeout(
        client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECT_TIMEOUT_MS }),
        CONNECT_TIMEOUT_MS,
        `listTools from MCP server "${this.name}"`,
      );
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  private async closeClient(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.healthy = false;
    if (client) await this.quietClose(client);
  }

  private async quietClose(client: Client): Promise<void> {
    try {
      await client.close();
    } catch {
      // Teardown path — a half-dead server must not break disposal.
    }
  }
}

// ---------------------------------------------------------------------------
// ③ ToolDefinition assembly
// ---------------------------------------------------------------------------

/**
 * Wrap one MCP tool as a pi `ToolDefinition`.
 *
 * - `parameters` is the MCP tool's raw draft-07 JSON Schema, passed through
 *   as-is: pi's validator takes the generic JSON-Schema path for schemas
 *   without a TypeBox Kind symbol (verified against pi 0.85.1, design §2.3-1).
 * - `isError` results MUST throw: pi hardcodes `isError: false` for normally
 *   resolved executes and only marks errors from exceptions (§2.3-2).
 * - The execute `signal` is forwarded into `callTool` RequestOptions so
 *   `session.abort()` cancels the in-flight request (and nothing else).
 */
export function wrapMcpTool(
  conn: McpConnection,
  tool: Tool,
  opts: McpBridgeOptions = {},
  name: string = sanitizeToolName(conn.name, tool.name),
): ToolDefinition {
  const callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  return {
    name,
    label: tool.title ?? tool.name,
    description: tool.description ?? `(MCP tool ${conn.name}/${tool.name})`,
    parameters: tool.inputSchema as unknown as ToolDefinition['parameters'],
    executionMode: opts.executionMode ?? 'sequential',
    execute: async (_toolCallId, params, signal) => {
      let client: Client;
      try {
        client = await conn.ensureClient();
      } catch (err) {
        throw new Error(`MCP server "${conn.name}" unavailable: ${errMsg(err)}`);
      }

      let result: CallToolResult;
      try {
        // The SDK's callTool return type is an inlined union incl. the legacy
        // compatibility shape; with no resultSchema it validates against
        // CallToolResultSchema at runtime, so the narrow cast is accurate.
        result = (await client.callTool(
          { name: tool.name, arguments: (params ?? {}) as Record<string, unknown> },
          undefined,
          { signal, timeout: callTimeoutMs },
        )) as CallToolResult;
      } catch (err) {
        throw new Error(
          `MCP tool ${tool.name} (server "${conn.name}") failed: ${errMsg(err)}`,
        );
      }

      if (result.isError) {
        // pi ignores isError on resolved executes — throwing is the only way
        // to surface the failure to the model (pi-agent-core tools.js).
        throw new Error(errorText(result, tool.name));
      }

      return { content: mapContentBlocks(result, opts), details: { mcpServer: conn.name } };
    },
  };
}

// ---------------------------------------------------------------------------
// ④ Facade
// ---------------------------------------------------------------------------

/**
 * Connect to every configured MCP server, list its tools, and wrap the lot
 * as pi `ToolDefinition[]`. A server that fails to connect or list within
 * the short connect timeouts is logged and skipped — one bad user-installed
 * server must not take down the provider (design §3.3).
 */
export async function mcpServersToPiCustomTools(
  servers: Record<string, McpServerConfig> | undefined,
  opts: McpBridgeOptions = {},
): Promise<McpBridgeHandle> {
  const log = opts.logger ?? (() => {});
  const connections: McpServerConnection[] = [];
  const tools: ToolDefinition[] = [];
  const assignName = createToolNamer(log);

  if (servers) {
    for (const [name, cfg] of Object.entries(servers)) {
      const conn = new McpServerConnection(name, cfg, log);
      let mcpTools: Tool[];
      try {
        mcpTools = await conn.connectAndListTools();
      } catch (err) {
        log(`MCP server "${name}" unavailable, skipping it (${errMsg(err)})`);
        await conn.close();
        continue;
      }
      connections.push(conn);
      for (const t of mcpTools) {
        tools.push(wrapMcpTool(conn, t, opts, assignName(name, t.name)));
      }
      log(`MCP server "${name}": bridged ${mcpTools.length} tool(s)`);
    }
  }

  return {
    tools,
    async dispose(): Promise<void> {
      // Exit/dispose path: swallow everything, in parallel.
      await Promise.allSettled(connections.map((c) => c.close()));
    },
  };
}

// --- memoized facade used by the pi provider factory -------------------------

function stableKey(value: unknown): string {
  if (!value || typeof value !== 'object' || Object.keys(value).length === 0) return 'none';
  return JSON.stringify(value, (_k: string, v: unknown): unknown => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return v;
  });
}

let cache: { configKey: string; handle: McpBridgeHandle } | null = null;
let chain: Promise<unknown> = Promise.resolve();

/**
 * Memoizing facade for the provider factory: builds the bridge on first call
 * and returns the cached `ToolDefinition[]` on later calls as long as the
 * server config deep-compares equal (key-order-insensitive). Config changes
 * rebuild the bridge (disposing the old connections). Calls are serialized to
 * keep the cache race-free.
 */
export function getPiMcpTools(
  servers?: Record<string, McpServerConfig>,
): Promise<ToolDefinition[]> {
  const run = chain
    .catch(() => {})
    .then(async (): Promise<ToolDefinition[]> => {
      const key = stableKey(servers);
      if (cache?.configKey === key) return cache.handle.tools;
      if (cache) {
        await cache.handle.dispose();
        cache = null;
      }
      const handle = await mcpServersToPiCustomTools(servers);
      cache = { configKey: key, handle };
      return handle.tools;
    });
  chain = run;
  return run;
}
