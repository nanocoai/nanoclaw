/**
 * Cursor SDK agent provider — local runtime inside the container.
 *
 * Talks to `@cursor/sdk` (`Agent.create` / `resume` / `send`). Continuation is
 * the Cursor `agentId`.
 *
 * Credentials never enter the container. The host passes
 * `CURSOR_API_KEY=cursor_placeholder_nanoclaw` and this provider hands the
 * same placeholder to the SDK, so every request the SDK authenticates with the
 * user key carries `Authorization: Bearer cursor_placeholder_nanoclaw`; the
 * credential gateway proxy (HTTPS_PROXY, set by the host at spawn) rewrites
 * that header on its two vaulted routes — the user-key exchange
 * (`api2.cursor.sh/auth/exchange_user_api_key`) and model discovery
 * (`api.cursor.com/v1/models`). The exchange returns a short-lived access
 * token the SDK holds in memory and sends on its Connect RPCs, which still
 * transit the same proxy. How each network path reaches the proxy, and the
 * one that cannot, is spelled out at `loadCursorSdk` below and proven by
 * `cursor.gateway-proxy.test.ts`.
 *
 * This module never imports the runtime contract (provider-contracts/cursor.ts):
 * registration is two-step, so it compiles and runs on a core that predates the
 * contract seam. The contract attaches itself through registerProviderContract
 * and reuses the section functions exported here.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import http2 from 'http2';
import os from 'os';
import path from 'path';
import tls from 'tls';

import type {
  AgentOptions,
  McpServerConfig as CursorMcpServerConfig,
  Run,
  RunResult,
  SDKMessage,
  SettingSource,
} from '@cursor/sdk';

import { memoryContextForSessionStart, type MemorySessionHookRegistration } from '../memory/session-hook.js';
import { archiveProviderExchange } from './exchange-archive.js';
import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  McpServerConfig,
  ProviderEvent,
  ProviderExchange,
  ProviderOptions,
  QueryInput,
} from './types.js';

const CONTENT_LENGTH_FETCH = Symbol.for('nanoclaw.cursor.content-length-fetch');
type MarkedFetch = typeof fetch & { [CONTENT_LENGTH_FETCH]?: boolean };

function knownBodyLength(body: BodyInit | null | undefined): number | null {
  if (body == null) return null;
  if (typeof body === 'string') return new TextEncoder().encode(body).byteLength;
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString()).byteLength;
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return null;
}

/**
 * Pin a Content-Length on every global-`fetch` request with a known body
 * length. The SDK's user-key exchange and its cloud REST client go through
 * global fetch, and those are the requests whose bearer header the credential
 * gateway must rewrite; a body sent as a chunked stream is something the
 * gateway has been observed to stall on rather than forward. Bun 1.3.14
 * already sets Content-Length for string and byte bodies, so on a current Bun
 * this is a no-op guard — it stays because the container pins its own Bun and
 * the header is what the gateway needs, not the body shape. It does not reach
 * the Connect RPCs: those leave through node:https (connect-node streams
 * their bodies, so they arrive chunked) and carry the exchanged token, which
 * the gateway forwards without rewriting.
 */
export function createContentLengthFetch(fetchImpl: typeof fetch): typeof fetch {
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const length = knownBodyLength(init?.body);
    const nextInit = length == null ? init : { ...init, headers: new Headers(init?.headers) };
    if (length != null) {
      const headers = (nextInit as RequestInit).headers as Headers;
      if (!headers.has('content-length')) headers.set('content-length', String(length));
    }
    return fetchImpl(input, nextInit);
  }) as MarkedFetch;
  wrapped[CONTENT_LENGTH_FETCH] = true;
  return wrapped;
}

const currentFetch = globalThis.fetch as MarkedFetch;
if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !currentFetch[CONTENT_LENGTH_FETCH]) {
  globalThis.fetch = createContentLengthFetch(currentFetch);
}

// ─── HTTP/2 proxy-bypass guard ──────────────────────────────────────────

const HTTP2_PROXY_GUARD = Symbol.for('nanoclaw.cursor.http2-proxy-guard');
type GuardMarked<T> = T & { [HTTP2_PROXY_GUARD]?: boolean };

export function http2ProxyBypassError(authority: string): Error {
  return new Error(
    `Cursor SDK attempted an HTTP/2 connection to ${authority} that would bypass the configured proxy; refusing (see /add-cursor troubleshooting)`,
  );
}

interface ProxyPolicy {
  /** null when HTTPS_PROXY is set but unparseable: nothing can match it. */
  proxyHost: string | null;
  proxyPort: string | null;
  noProxy: string[];
}

function defaultPort(protocol: string): string {
  return protocol === 'http:' ? '80' : '443';
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^\[(.*)\]$/, '$1');
}

function proxyPolicy(env: NodeJS.ProcessEnv): ProxyPolicy | null {
  const raw = env.HTTPS_PROXY || env.https_proxy;
  if (!raw) return null;
  const noProxy = (env.NO_PROXY || env.no_proxy || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  try {
    const url = new URL(raw);
    return { proxyHost: normalizeHost(url.hostname), proxyPort: url.port || defaultPort(url.protocol), noProxy };
  } catch {
    return { proxyHost: null, proxyPort: null, noProxy };
  }
}

/** Standard NO_PROXY semantics: `*`, exact host, or domain suffix (leading dot optional). */
function matchesNoProxy(host: string, noProxy: string[]): boolean {
  return noProxy.some((entry) => {
    if (entry === '*') return true;
    const bare = entry.replace(/:\d+$/, '').replace(/^\./, '');
    return bare.length > 0 && (host === bare || host.endsWith(`.${bare}`));
  });
}

function permitsDial(policy: ProxyPolicy, host: string, port: string | number): boolean {
  const target = normalizeHost(host);
  if (policy.proxyHost !== null && target === policy.proxyHost && String(port) === policy.proxyPort) return true;
  return matchesNoProxy(target, policy.noProxy);
}

function wantsHttp2(protocols: unknown): boolean {
  if (!Array.isArray(protocols)) return false;
  return protocols.some(
    (protocol) =>
      (typeof protocol === 'string'
        ? protocol
        : protocol instanceof Uint8Array
          ? new TextDecoder().decode(protocol)
          : '') === 'h2',
  );
}

/**
 * Close the one Cursor network path the credential gateway cannot see. Bun's
 * `node:http2` client ignores HTTPS_PROXY, so an HTTP/2 Connect transport
 * would carry the agent's runtime token straight to Cursor. While a proxy is
 * configured, any HTTP/2 session to an origin other than the proxy itself (or
 * a NO_PROXY host, which the operator has excluded from the proxy on purpose)
 * throws `http2ProxyBypassError` instead of dialing. Nothing is tunnelled: the
 * refusal is the whole behaviour, and the SDK surfaces it as a run error.
 *
 * Two hooks, because of how Bun binds builtins:
 *
 *   - `http2.connect` on the module object. A builtin's ESM namespace is a
 *     snapshot taken when the first `import` of it evaluates, so this wrap
 *     only reaches importers loaded after it. In the agent-runner the Claude
 *     SDK imports http2 before the provider barrel reaches this module, so
 *     `@connectrpc/connect-node` (the SDK's HTTP/2 session manager, the only
 *     `http2.connect` caller in the Cursor stack) keeps the original in
 *     production. Kept for the callers it does bind and for the clearest
 *     error at the earliest point.
 *   - `tls.connect`. Bun's http2 client resolves it from the module object at
 *     dial time with `ALPNProtocols: ['h2']`, so this hook holds whatever the
 *     load order, and a throw here propagates synchronously out of
 *     `http2.connect`. Bun's fetch and `node:https` clients dial natively and
 *     never pass through it, so proxied HTTP/1.1 traffic is untouched.
 *
 * Returns null when no proxy is configured (nothing installed, local runs
 * without the gateway behave exactly as before), otherwise a restore function
 * for tests. Idempotent: a marker symbol on each wrapped function prevents
 * double wrapping.
 */
export function installHttp2ProxyGuard(env: NodeJS.ProcessEnv = process.env): (() => void) | null {
  const policy = proxyPolicy(env);
  if (!policy) return null;
  const restores: Array<() => void> = [];

  const http2Module = http2 as { connect: GuardMarked<typeof http2.connect> };
  const originalConnect = http2Module.connect;
  if (!originalConnect[HTTP2_PROXY_GUARD]) {
    const guardedConnect = function (this: unknown, authority: string | URL, ...rest: unknown[]) {
      const url = typeof authority === 'string' ? new URL(authority) : authority;
      if (!permitsDial(policy, url.hostname, url.port || defaultPort(url.protocol))) {
        throw http2ProxyBypassError(typeof authority === 'string' ? authority : authority.href);
      }
      return (originalConnect as unknown as (...args: unknown[]) => http2.ClientHttp2Session).apply(this, [
        authority,
        ...rest,
      ]);
    } as unknown as GuardMarked<typeof http2.connect>;
    guardedConnect[HTTP2_PROXY_GUARD] = true;
    http2Module.connect = guardedConnect;
    restores.push(() => {
      http2Module.connect = originalConnect;
    });
  }

  const tlsModule = tls as { connect: GuardMarked<typeof tls.connect> };
  const originalTlsConnect = tlsModule.connect;
  if (!originalTlsConnect[HTTP2_PROXY_GUARD]) {
    const guardedTlsConnect = function (this: unknown, ...args: unknown[]) {
      const options = args.find((arg) => arg !== null && typeof arg === 'object' && !Array.isArray(arg)) as
        | tls.ConnectionOptions
        | undefined;
      if (options && wantsHttp2(options.ALPNProtocols)) {
        const host = options.host ?? (typeof args[1] === 'string' ? args[1] : 'localhost');
        const port = options.port ?? (typeof args[0] === 'number' ? args[0] : '');
        if (!permitsDial(policy, host, port)) throw http2ProxyBypassError(`https://${host}:${port}`);
      }
      return (originalTlsConnect as unknown as (...args: unknown[]) => tls.TLSSocket).apply(this, args);
    } as unknown as GuardMarked<typeof tls.connect>;
    guardedTlsConnect[HTTP2_PROXY_GUARD] = true;
    tlsModule.connect = guardedTlsConnect;
    restores.push(() => {
      tlsModule.connect = originalTlsConnect;
    });
  }

  return () => {
    for (const restore of restores.reverse()) restore();
  };
}

let cursorSdkPromise: Promise<typeof import('@cursor/sdk')> | undefined;

/**
 * How Cursor traffic reaches the credential gateway proxy (Bun runtime):
 *
 *   - user-key exchange + cloud REST: the SDK calls global `fetch`, and Bun's
 *     fetch honors HTTPS_PROXY / https_proxy (CONNECT to the proxy) and the
 *     gateway's CA bundle (SSL_CERT_FILE / NODE_EXTRA_CA_CERTS).
 *   - Connect RPCs (agent runtime): `@connectrpc/connect-node` over
 *     HTTP/1.1, which is `node:https` — Bun implements that client on the same
 *     proxy-aware stack, so it CONNECTs through the proxy too.
 *   - Connect RPCs over HTTP/2: `node:http2` in Bun ignores HTTPS_PROXY and
 *     would dial the backend directly. The SDK already defaults to HTTP/1.1
 *     under Bun and `useHttp1ForAgent: true` pins that choice, but Cursor's
 *     server-side `http2Config` force flag is applied over the client setting
 *     and the SDK exports no transport factory to swap. So the path is closed
 *     client-side instead: `installHttp2ProxyGuard` runs here, before the SDK
 *     loads, and while a proxy is configured every HTTP/2 session to an
 *     origin other than the proxy is refused with a clear error rather than
 *     dialed (details on the guard). `cursor.gateway-proxy.test.ts` proves
 *     both the happy path and the refusal when the server forces HTTP/2.
 *
 * The client-side guard is one layer. The operator-side layer is core's
 * `NANOCLAW_EGRESS_LOCKDOWN=true`: the container joins an internal Docker
 * network whose only hop is the gateway, so any bypass attempt fails at the
 * network as well.
 */
async function loadCursorSdk(): Promise<typeof import('@cursor/sdk')> {
  cursorSdkPromise ??= (async () => {
    installHttp2ProxyGuard();
    const sdk = await import('@cursor/sdk');
    sdk.Cursor.configure({ local: { useHttp1ForAgent: true } });
    return sdk;
  })();
  return cursorSdkPromise;
}

/** Sentinel so the SDK always sends Authorization for the gateway to overwrite. */
export const CURSOR_API_KEY_PLACEHOLDER = 'cursor_placeholder_nanoclaw';

/**
 * Built-in Cursor tools that stall a headless session or bypass NanoClaw
 * `ask_user_question`. `task` is included because `disallowedTools` applies
 * only to the main loop — subagents keep their own toolset and could still
 * call `askQuestion`.
 */
export const CURSOR_DISALLOWED_TOOLS: Array<'askQuestion' | 'await' | 'task'> = ['askQuestion', 'await', 'task'];

export const CURSOR_DEFAULT_MODEL = 'composer-2.5';
export const CURSOR_MEMORY_HOOK_COMMAND = 'bun /app/src/providers/cursor-hook.ts';

const STALE_SESSION_RE = /agent not found|unknown agent|no conversation|session.*not found/i;
const ACTIVE_RUN_RE = /already has (?:an )?active run/i;

/**
 * SDK entry points, overridable in unit tests so a fake Agent can drive
 * event mapping without `mock.module` leaking into the barrel registration test.
 */
export const cursorAgentApi = {
  create: async (options: AgentOptions) => (await loadCursorSdk()).Agent.create(options),
  resume: async (agentId: string, options: AgentOptions) => (await loadCursorSdk()).Agent.resume(agentId, options),
};

function log(msg: string): void {
  console.error(`[cursor-provider] ${msg}`);
}

function cursorHome(): string {
  return path.join(process.env.HOME || os.homedir(), '.cursor');
}

function agentRoot(): string {
  return process.env.NANOCLAW_AGENT_DIR || '/workspace/agent';
}

// ─── configuration sections ─────────────────────────────────────────────
// Per-capability plan functions. The runtime contract declares these same
// functions (or their constant results); the legacy path (a core without the
// contract seam) calls them from the constructor. Both land on the same
// AgentOptions.

export interface CursorExecutionPolicy {
  disallowedTools: Array<'askQuestion' | 'await' | 'task'>;
  /**
   * Project + user layers. Container HOME is the per-group `.cursor-shared`
   * mount, not a desktop Cursor install, so `"user"` loads persistent
   * ~/.cursor/skills and hooks.json. Inline MCP still wins.
   */
  settingSources: SettingSource[];
  /** The container is the sandbox; Cursor's own is off. */
  sandbox: { enabled: false };
}

export function cursorExecutionPolicySection(): CursorExecutionPolicy {
  return {
    disallowedTools: [...CURSOR_DISALLOWED_TOOLS],
    settingSources: ['project', 'user'],
    sandbox: { enabled: false },
  };
}

export interface CursorInference {
  model: { id: string };
}

/**
 * Cursor's `ModelSelection` is `{ id, params? }` where `params` are
 * per-model parameter values only discoverable from the live model catalogue,
 * so the core `effort` and `speed` inputs have no honest mapping here and are
 * ignored; the host contract declares no speed tiers for the same reason.
 */
export function cursorInferenceSection(input: { model?: string; effort?: string; speed?: string }): CursorInference {
  return { model: { id: input.model || CURSOR_DEFAULT_MODEL } };
}

export interface CursorMemoryHooks {
  version: 1;
  hooks: {
    sessionStart: Array<{ command: string }>;
    preCompact: Array<{ command: string }>;
  };
}

/**
 * The Cursor-native hooks that feed shared memory into a session. They run
 * `cursor-hook.ts`, which reads the memory tree directly, so they do not
 * depend on the hook command core registers — a declared constant.
 */
export function cursorMemorySection(): CursorMemoryHooks {
  return {
    version: 1,
    hooks: {
      sessionStart: [{ command: CURSOR_MEMORY_HOOK_COMMAND }],
      preCompact: [{ command: `${CURSOR_MEMORY_HOOK_COMMAND} --compact` }],
    },
  };
}

export function mapMcpServers(servers: Record<string, McpServerConfig>): Record<string, CursorMcpServerConfig> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => {
      if (server.type === 'http') {
        return [name, { type: 'http' as const, url: server.url, headers: server.headers ?? {} }];
      }
      return [
        name,
        {
          type: 'stdio' as const,
          command: server.command,
          args: server.args ?? [],
          env: server.env ?? {},
          ...(server.cwd ? { cwd: server.cwd } : {}),
        },
      ];
    }),
  );
}

export const cursorMcpServersSection = mapMcpServers;

/**
 * Mixed-version ownership of the hooks.json writes. When the runtime contract
 * module loads it flips this flag: core then runs the contract's
 * memorySessionHookRegistration callback, so the provider's own write in
 * registerMemorySessionHook stands down instead of writing the files twice.
 */
export const cursorRuntimeOwnership = { contractOwnsHookFiles: false };

// ─── stream helpers ─────────────────────────────────────────────────────

export function extractAssistantText(event: SDKMessage): string {
  if (event.type !== 'assistant') return '';
  const blocks = event.message?.content ?? [];
  return blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

export function toolProgressMessage(event: SDKMessage): string | null {
  if (event.type !== 'tool_call') return null;
  const name = event.name || 'tool';
  if (event.status === 'running') return `${name}…`;
  if (event.status === 'error') return `${name} failed`;
  return null;
}

export async function* waitForRunWithActivity(
  run: Pick<Run, 'wait'>,
  heartbeatMs = 15_000,
): AsyncGenerator<ProviderEvent, RunResult> {
  type WaitOutcome = { result: RunResult } | { error: unknown };
  const completion: Promise<WaitOutcome> = run.wait().then(
    (result): WaitOutcome => ({ result }),
    (error: unknown): WaitOutcome => ({ error }),
  );

  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const heartbeat = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), heartbeatMs);
    });
    const outcome = await Promise.race([completion, heartbeat]);
    if (outcome === null) {
      yield { type: 'activity' };
      continue;
    }
    if (timer) clearTimeout(timer);
    if ('error' in outcome) throw outcome.error;
    return outcome.result;
  }
}

// ─── hooks.json ─────────────────────────────────────────────────────────

interface CursorHooksDocument {
  version?: unknown;
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

function readHooksDocument(filePath: string): CursorHooksDocument | null {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as CursorHooksDocument;
    log(`Leaving non-object Cursor hooks document unchanged at ${filePath}`);
  } catch (err) {
    log(
      `Leaving malformed Cursor hooks document unchanged at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return null;
}

function mergeMemoryHooks(filePath: string, memory: CursorMemoryHooks): void {
  const payload = readHooksDocument(filePath);
  if (!payload) return;
  const hooks =
    payload.hooks && typeof payload.hooks === 'object' && !Array.isArray(payload.hooks) ? payload.hooks : {};
  for (const [name, entries] of Object.entries(memory.hooks)) {
    const existing = Array.isArray(hooks[name]) ? hooks[name] : [];
    const ours = new Set(entries.map((entry) => entry.command));
    hooks[name] = [
      ...existing.filter(
        (entry) =>
          !entry ||
          typeof entry !== 'object' ||
          !('command' in entry) ||
          !ours.has((entry as { command?: unknown }).command as string),
      ),
      ...entries,
    ];
  }
  payload.version = memory.version;
  payload.hooks = hooks;
  // Write into a fresh, unpredictable sibling and rename over the target: the
  // hooks file is inside directories the agent can write, so the temp path
  // must not be one an earlier process could have planted a symlink at.
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(tempPath, filePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

/**
 * Merge the shared-memory hooks into Cursor's project (`<agent>/.cursor`) and
 * user (`~/.cursor`) hooks.json — idempotent, preserving unrelated hooks. The
 * contract's memorySessionHookRegistration callback calls this on a contract
 * core; the provider calls it itself on a pre-contract core.
 */
export function writeCursorMemoryHooks(memory: CursorMemoryHooks = cursorMemorySection()): void {
  const projectDir = path.join(agentRoot(), '.cursor');
  fs.mkdirSync(projectDir, { recursive: true });
  mergeMemoryHooks(path.join(projectDir, 'hooks.json'), memory);

  const userDir = cursorHome();
  fs.mkdirSync(userDir, { recursive: true });
  mergeMemoryHooks(path.join(userDir, 'hooks.json'), memory);
}

/**
 * Cursor keeps its history in the SDK's local agent store, not a transcript,
 * so each exchange is persisted into `conversations/` through the shared
 * archive plan. The contract's afterExchange calls this with core's clock; the
 * provider's own onExchangeComplete is the pre-contract fallback.
 */
export function archiveCursorExchange(exchange: ProviderExchange, timestamp?: Date): string | null {
  try {
    return archiveProviderExchange({
      provider: 'cursor',
      prompt: exchange.prompt,
      result: exchange.result,
      continuation: exchange.continuation,
      status: exchange.status,
      timestamp,
    });
  } catch (err) {
    log(`Failed to archive exchange: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Structural mirror of the contract core's `ResolvedRuntimeConfiguration` —
 * what `createProvider` hands the factory after running the contract's
 * configuration resolves. Mirrored, not imported: the type lives in
 * `provider-contracts/registry.ts`, which a pre-contract core does not have.
 */
export interface CursorResolvedConfiguration {
  executionPolicy?: unknown;
  inference?: unknown;
  mcpServers?: unknown;
}

export class CursorProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  readonly emitsMidTurnText = true;

  private readonly assistantName?: string;
  private readonly additionalDirectories?: string[];
  private readonly executionPolicy: CursorExecutionPolicy;
  private readonly inference: CursorInference;
  private readonly mcpServers: Record<string, CursorMcpServerConfig>;
  private memorySessionHook?: MemorySessionHookRegistration;

  /**
   * `configuration` is present on a contract core: core has already run the
   * contract's resolves and hands the results over, so they are consumed
   * as-is. Without it (a pre-contract core) the provider derives the same
   * values itself from the options, exactly as it always did.
   */
  constructor(options: ProviderOptions = {}, configuration?: CursorResolvedConfiguration) {
    this.assistantName = options.assistantName;
    this.additionalDirectories = options.additionalDirectories;
    if (configuration) {
      this.executionPolicy = configuration.executionPolicy as CursorExecutionPolicy;
      this.inference = configuration.inference as CursorInference;
      this.mcpServers = configuration.mcpServers as Record<string, CursorMcpServerConfig>;
    } else {
      this.executionPolicy = cursorExecutionPolicySection();
      // `speed` exists on ProviderOptions only from the contract core on; read
      // it structurally so this compiles against the older options type too.
      const { speed } = options as ProviderOptions & { speed?: string };
      this.inference = cursorInferenceSection({ model: options.model, effort: options.effort, speed });
      this.mcpServers = mapMcpServers(options.mcpServers ?? {});
    }
  }

  registerMemorySessionHook(hook: MemorySessionHookRegistration): void {
    // On a contract core the contract's memorySessionHookRegistration has
    // already written both hooks.json files (see cursorRuntimeOwnership).
    if (!cursorRuntimeOwnership.contractOwnsHookFiles) writeCursorMemoryHooks();
    this.memorySessionHook = hook;
  }

  isSessionInvalid(err: unknown): boolean {
    if (err instanceof Error && err.name === 'AgentNotFoundError') return true;
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  // A contract core replaces this with the contract's afterExchange at the
  // factory boundary; a pre-contract core calls it directly.
  onExchangeComplete(exchange: ProviderExchange): void {
    archiveCursorExchange(exchange);
  }

  private agentOptions(cwd: string): AgentOptions {
    return {
      apiKey: CURSOR_API_KEY_PLACEHOLDER,
      name: this.assistantName,
      model: this.inference.model,
      mcpServers: this.mcpServers,
      disallowedTools: [...this.executionPolicy.disallowedTools],
      local: {
        cwd,
        dirs: this.additionalDirectories,
        settingSources: [...this.executionPolicy.settingSources],
        sandboxOptions: { enabled: this.executionPolicy.sandbox.enabled },
      },
    };
  }

  query(input: QueryInput): AgentQuery {
    if (!this.memorySessionHook) throw new Error('Cursor memory session hook was not registered');

    let aborted = false;
    let currentRun: Run | null = null;
    let cancelPromise: Promise<void> | null = null;
    let acceptingInput = true;
    const pendingPrompts = [input.prompt];
    const options = this.agentOptions(input.cwd);
    const isInvalidSession = (err: unknown): boolean => this.isSessionInvalid(err);
    let injectedMemory = false;
    const withSystemInstructions = (prompt: string): string => {
      const parts: string[] = [];
      if (input.systemContext?.instructions) parts.push(input.systemContext.instructions);
      // Cursor's sessionStart hook is documented as fire-and-forget; live runs
      // confirm additional_context does not land in the model. Prepend the
      // shared memory index on the first send of a new session. Resumes already
      // have that context, and follow-up pushes skip it.
      if (!injectedMemory) {
        const memory = memoryContextForSessionStart(input.continuation ? 'resume' : 'startup', input.cwd);
        if (memory) parts.push(memory);
        injectedMemory = true;
      }
      parts.push(prompt);
      return parts.join('\n\n');
    };

    const cancelCurrentRun = (): Promise<void> => {
      if (!currentRun?.supports('cancel')) return Promise.resolve();
      if (cancelPromise) return cancelPromise;
      try {
        cancelPromise = currentRun.cancel().catch((err) => {
          log(`Failed to cancel run: ${err instanceof Error ? err.message : String(err)}`);
        });
      } catch (err) {
        log(`Failed to cancel run: ${err instanceof Error ? err.message : String(err)}`);
        cancelPromise = Promise.resolve();
      }
      return cancelPromise;
    };

    async function* translateEvents(): AsyncGenerator<ProviderEvent> {
      let agent: Awaited<ReturnType<(typeof cursorAgentApi)['create']>> | null = null;
      try {
        agent = input.continuation
          ? await cursorAgentApi.resume(input.continuation, options)
          : await cursorAgentApi.create(options);

        if (aborted) return;
        yield { type: 'init', continuation: agent.agentId };

        while (!aborted && pendingPrompts.length > 0) {
          const prompt = pendingPrompts.shift()!;
          yield { type: 'activity' };
          if (aborted) return;

          const preparedPrompt = withSystemInstructions(prompt);
          let run: Run;
          try {
            run = await agent.send(preparedPrompt);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (!ACTIVE_RUN_RE.test(message)) throw err;
            log('Expiring stale active Cursor run and retrying the message');
            run = await agent.send(preparedPrompt, { local: { force: true } });
          }
          currentRun = run;
          cancelPromise = null;
          if (aborted) {
            await cancelCurrentRun();
            return;
          }

          let streamed = '';
          if (run.supports('stream')) {
            for await (const event of run.stream()) {
              if (aborted) {
                await cancelCurrentRun();
                return;
              }
              yield { type: 'activity' };
              const text = extractAssistantText(event);
              streamed += text;
              if (text) yield { type: 'text', text };
              const progress = toolProgressMessage(event);
              if (progress) yield { type: 'progress', message: progress };
            }
          }

          const waitEvents = waitForRunWithActivity(run);
          let result: RunResult;
          while (true) {
            const next = await waitEvents.next();
            if (next.done) {
              result = next.value;
              break;
            }
            if (aborted) {
              await cancelCurrentRun();
              return;
            }
            yield next.value;
          }
          currentRun = null;
          cancelPromise = null;
          if (aborted) return;

          if (result.status === 'cancelled') {
            yield { type: 'error', message: 'Cancelled', retryable: false };
            yield { type: 'result', text: 'Cancelled', isError: true };
            return;
          } else if (result.status === 'error') {
            const text = result.error?.message || result.result || streamed || 'Cursor run failed';
            yield { type: 'result', text, isError: true };
          } else {
            yield { type: 'result', text: result.result ?? (streamed || null) };
          }
        }
      } catch (err) {
        if (aborted) return;
        if (input.continuation && isInvalidSession(err)) throw err;
        const { CursorAgentError } = await loadCursorSdk();
        if (err instanceof CursorAgentError) {
          yield {
            type: 'error',
            message: err.message,
            retryable: err.isRetryable,
            classification: err.code,
          };
          yield { type: 'result', text: err.message, isError: true };
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        yield {
          type: 'error',
          message,
          retryable: false,
        };
        yield { type: 'result', text: message, isError: true };
      } finally {
        acceptingInput = false;
        currentRun = null;
        try {
          agent?.close();
        } catch (err) {
          log(`Failed to close agent: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    return {
      push(message) {
        if (acceptingInput && !aborted) pendingPrompts.push(message);
      },
      end() {
        acceptingInput = false;
      },
      events: translateEvents(),
      abort() {
        aborted = true;
        void cancelCurrentRun();
      },
    };
  }
}

// Function-form registration only — the one shape both core generations
// accept. A contract core passes the resolved configuration as the second
// argument; a pre-contract core passes nothing there.
registerProvider(
  'cursor',
  (opts, configuration?: CursorResolvedConfiguration) => new CursorProvider(opts, configuration),
);
