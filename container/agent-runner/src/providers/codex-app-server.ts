import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { createInterface, type Interface as ReadlineInterface } from 'readline';

// Cap Codex's project-doc loading (AGENTS.md). The host-side composer
// (src/providers/codex-agents-md.ts) enforces the same cap at compose time —
// host and container share no modules, so the constant lives in both.
const CODEX_PROJECT_DOC_MAX_BYTES = 32 * 1024;

function log(msg: string): void {
  console.error(`[codex-app-server] ${msg}`);
}

const INIT_TIMEOUT_MS = 30_000;

export const CODEX_APP_SERVER_ARGS = ['--dangerously-bypass-hook-trust', 'app-server', '--listen', 'stdio://'] as const;

export interface CodexMemorySessionHook {
  readonly command: string;
  readonly legacyCommands: readonly string[];
  readonly sources: readonly string[];
}

export const STALE_THREAD_RE = /thread\s+not\s+found|unknown\s+thread|thread[_\s]id|no such thread/i;

let nextRequestId = 1;

export interface JsonRpcResponse {
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcServerRequest {
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification | JsonRpcServerRequest;

export interface AppServer {
  process: ChildProcess;
  readline: ReadlineInterface;
  pending: Map<number | string, { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }>;
  notificationHandlers: Array<(n: JsonRpcNotification) => void>;
  serverRequestHandlers: Array<(r: JsonRpcServerRequest) => void>;
  /**
   * Fired when the app-server process dies (exit or spawn error). Pending
   * request/response pairs are rejected separately via failPending — but a
   * turn in flight has NO pending request (turn/start already resolved); it
   * is parked on a notification waker that a dead process will never kick.
   * Without these handlers a mid-turn crash surfaces as a 10-minute turn
   * timeout instead of the real exit code, after the --rm container has
   * already taken the server's stderr with it.
   */
  exitHandlers: Array<(err: Error) => void>;
}

export interface CodexMcpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type CodexReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

// Codex runs unrestricted inside the container. NanoClaw's container isolation and
// the OneCLI allow-list are the security boundary — not Codex's own sandbox/approval
// primitives (which can't run here anyway: workspace-write/read-only need user
// namespaces, which the agent containers deny). Both are hardcoded as instance-level
// defaults in config.toml; threads and turns inherit them, never override them.
const CODEX_SANDBOX_MODE = 'danger-full-access';
const CODEX_APPROVAL_POLICY = 'never';

const CODEX_ENV_ALLOWLIST = new Set([
  'ALL_PROXY',
  'CURL_CA_BUNDLE',
  'GIT_SSL_CAINFO',
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LANG',
  'LC_ALL',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'PATH',
  'PNPM_HOME',
  'REQUESTS_CA_BUNDLE',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'TZ',
  'USER',
  'all_proxy',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'CODEX_HOME',
]);

export interface ThreadParams {
  model?: string;
  cwd: string;
  baseInstructions?: string;
  developerInstructions?: string;
}

export interface TurnParams {
  threadId: string;
  inputText: string;
  model?: string;
  effort?: string;
  cwd?: string;
}

export function spawnCodexAppServer(): AppServer {
  // NanoClaw generates the hook config and has no interactive user available
  // to approve hook trust inside the container.
  const args = [...CODEX_APP_SERVER_ARGS];
  log(`Spawning: codex ${args.join(' ')}`);

  const proc = spawn('codex', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: buildCodexProcessEnv(process.env),
  });
  const rl = createInterface({ input: proc.stdout! });

  const server: AppServer = {
    process: proc,
    readline: rl,
    pending: new Map(),
    notificationHandlers: [],
    exitHandlers: [],
    serverRequestHandlers: [],
  };

  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) log(`[stderr] ${text}`);
  });

  rl.on('line', (line: string) => {
    if (!line.trim()) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      log(`[parse-error] ${line.slice(0, 200)}`);
      return;
    }

    if (isResponse(msg)) {
      const handler = server.pending.get(msg.id);
      if (handler) {
        server.pending.delete(msg.id);
        handler.resolve(msg);
      }
    } else if (isServerRequest(msg)) {
      for (const h of server.serverRequestHandlers) h(msg);
    } else if ('method' in msg) {
      for (const h of server.notificationHandlers) h(msg as JsonRpcNotification);
    }
  });

  const failPending = (err: Error): void => {
    for (const [, handler] of server.pending) handler.reject(err);
    server.pending.clear();
  };

  proc.on('error', (err) => {
    log(`[process-error] ${err.message}`);
    failPending(err);
    for (const h of [...server.exitHandlers]) h(err);
  });

  proc.on('exit', (code, signal) => {
    log(`[exit] code=${code} signal=${signal}`);
    const err = new Error(`Codex app-server exited: code=${code} signal=${signal}`);
    failPending(err);
    for (const h of [...server.exitHandlers]) h(err);
  });

  return server;
}

export function sendCodexRequest(
  server: AppServer,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<JsonRpcResponse> {
  const id = nextRequestId++;
  const req = params === undefined ? { id, method } : { id, method, params };
  const line = JSON.stringify(req) + '\n';

  return new Promise<JsonRpcResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.pending.delete(id);
      reject(new Error(`Timeout waiting for ${method} response (${timeoutMs}ms)`));
    }, timeoutMs);

    server.pending.set(id, {
      resolve: (r) => {
        clearTimeout(timer);
        resolve(r);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });

    try {
      server.process.stdin!.write(line);
    } catch (err) {
      clearTimeout(timer);
      server.pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export function sendCodexNotification(server: AppServer, method: string, params?: Record<string, unknown>): void {
  const line = JSON.stringify(params === undefined ? { method } : { method, params }) + '\n';
  server.process.stdin!.write(line);
}

export function sendCodexResponse(server: AppServer, id: number | string, result: unknown): void {
  try {
    server.process.stdin!.write(JSON.stringify({ id, result }) + '\n');
  } catch (err) {
    log(`[send-error] response id=${id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function killCodexAppServer(server: AppServer): void {
  try {
    server.readline.close();
    server.process.kill('SIGTERM');
  } catch {
    /* ignore */
  }
}

export async function initializeCodexAppServer(server: AppServer): Promise<void> {
  const resp = await sendCodexRequest(
    server,
    'initialize',
    {
      clientInfo: { name: 'nanoclaw', title: 'NanoClaw', version: '2.0' },
      capabilities: { experimentalApi: true },
    },
    INIT_TIMEOUT_MS,
  );
  if (resp.error) throw new Error(`initialize failed: ${resp.error.message}`);
  sendCodexNotification(server, 'initialized');
}

export async function startOrResumeCodexThread(
  server: AppServer,
  threadId: string | undefined,
  params: ThreadParams,
): Promise<string> {
  const commonParams = {
    model: params.model,
    cwd: params.cwd,
    approvalPolicy: CODEX_APPROVAL_POLICY,
    sandbox: CODEX_SANDBOX_MODE,
    baseInstructions: params.baseInstructions,
    developerInstructions: params.developerInstructions,
    personality: 'friendly',
    persistExtendedHistory: false,
  };

  if (threadId) {
    const resp = await sendCodexRequest(server, 'thread/resume', {
      threadId,
      ...commonParams,
      excludeTurns: true,
    });
    if (!resp.error) return threadId;
    if (!STALE_THREAD_RE.test(resp.error.message)) {
      throw new Error(`thread/resume failed: ${resp.error.message}`);
    }
    log(`Stale thread ${threadId}; starting fresh thread.`);
  }

  const resp = await sendCodexRequest(server, 'thread/start', {
    ...commonParams,
    sessionStartSource: 'startup',
    experimentalRawEvents: false,
  });
  if (resp.error) throw new Error(`thread/start failed: ${resp.error.message}`);

  const result = resp.result as { thread?: { id?: string } } | undefined;
  const newThreadId = result?.thread?.id;
  if (!newThreadId) throw new Error('thread/start response missing thread ID');
  return newThreadId;
}

export async function startCodexTurn(server: AppServer, params: TurnParams): Promise<string> {
  const resp = await sendCodexRequest(server, 'turn/start', {
    threadId: params.threadId,
    input: [{ type: 'text', text: params.inputText, text_elements: [] }],
    model: params.model,
    effort: params.effort,
    cwd: params.cwd,
  });
  if (resp.error) throw new Error(`turn/start failed: ${resp.error.message}`);
  const result = resp.result as { turn?: { id?: string } } | undefined;
  const turnId = result?.turn?.id;
  if (!turnId) throw new Error('turn/start response missing turn ID');
  return turnId;
}

export async function steerCodexTurn(
  server: AppServer,
  threadId: string,
  turnId: string,
  inputText: string,
): Promise<void> {
  const resp = await sendCodexRequest(server, 'turn/steer', {
    threadId,
    expectedTurnId: turnId,
    input: [{ type: 'text', text: inputText, text_elements: [] }],
  });
  if (resp.error) throw new Error(`turn/steer failed: ${resp.error.message}`);
}

export async function interruptCodexTurn(server: AppServer, threadId: string, turnId: string): Promise<void> {
  const resp = await sendCodexRequest(server, 'turn/interrupt', { threadId, turnId }, 10_000);
  if (resp.error) throw new Error(`turn/interrupt failed: ${resp.error.message}`);
}

// With approval_policy=never the command/patch approval requests don't fire, but the
// app-server still sends a few non-approval server→client requests (permission
// negotiation, MCP elicitations, tool calls) that must be answered or the turn hangs.
// NanoClaw is the boundary, so accept/grant everything.
export function attachCodexAutoApproval(server: AppServer): void {
  server.serverRequestHandlers.push((req) => {
    switch (req.method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        sendCodexResponse(server, req.id, { decision: 'accept' });
        break;
      case 'applyPatchApproval':
      case 'execCommandApproval':
        sendCodexResponse(server, req.id, { decision: 'approved' });
        break;
      case 'item/permissions/requestApproval':
        sendCodexResponse(server, req.id, {
          permissions: { fileSystem: { read: ['/'], write: ['/'] }, network: { enabled: true } },
          scope: 'turn',
          strictAutoReview: true,
        });
        break;
      case 'item/tool/requestUserInput':
        sendCodexResponse(server, req.id, { answers: {} });
        break;
      case 'mcpServer/elicitation/request':
        sendCodexResponse(server, req.id, { action: 'cancel', content: null, _meta: null });
        break;
      case 'item/tool/call':
        sendCodexResponse(server, req.id, { success: false, contentItems: [] });
        break;
      default:
        sendCodexError(server, req.id, `Unhandled Codex app-server request: ${req.method}`);
        break;
    }
  });
}

export function writeCodexConfigToml(
  servers: Record<string, CodexMcpServer>,
  memorySessionHook: CodexMemorySessionHook,
  opts: { model?: string; effort?: string } = {},
): void {
  const codexConfigDir = path.join(process.env.HOME || '/home/node', '.codex');
  fs.mkdirSync(codexConfigDir, { recursive: true });
  const configTomlPath = path.join(codexConfigDir, 'config.toml');
  const hooksJsonPath = path.join(codexConfigDir, 'hooks.json');

  // Instance-level defaults the app-server reads on startup; threads/turns inherit them.
  const lines: string[] = [
    `sandbox_mode = ${tomlBasicString(CODEX_SANDBOX_MODE)}`,
    `approval_policy = ${tomlBasicString(CODEX_APPROVAL_POLICY)}`,
    `project_doc_max_bytes = ${CODEX_PROJECT_DOC_MAX_BYTES}`,
  ];
  if (opts.model) lines.push(`model = ${tomlBasicString(opts.model)}`);
  if (opts.effort) lines.push(`model_reasoning_effort = ${tomlBasicString(opts.effort)}`);
  lines.push('');

  // NanoClaw owns persistent memory across providers. Keep Codex's native
  // memory disabled even if its defaults or a user-level config change.
  lines.push('[features]');
  lines.push('memories = false');
  lines.push('');
  lines.push('[memories]');
  lines.push('use_memories = false');
  lines.push('generate_memories = false');
  lines.push('');

  for (const [name, config] of Object.entries(servers)) {
    lines.push(`[mcp_servers.${name}]`);
    lines.push(`command = ${tomlBasicString(config.command)}`);
    if (config.args && config.args.length > 0) {
      lines.push(`args = [${config.args.map(tomlBasicString).join(', ')}]`);
    }
    if (config.env && Object.keys(config.env).length > 0) {
      lines.push(`[mcp_servers.${name}.env]`);
      for (const [key, value] of Object.entries(config.env)) {
        lines.push(`${key} = ${tomlBasicString(value)}`);
      }
    }
    lines.push('');
  }

  fs.writeFileSync(configTomlPath, lines.join('\n'));
  const hooksConfig = readHooksConfig(hooksJsonPath);
  const hooks = objectProperty(hooksConfig, 'hooks');
  const sessionStart = arrayProperty(hooks, 'SessionStart');

  const memoryCommands = new Set([memorySessionHook.command, ...memorySessionHook.legacyCommands]);
  const nextSessionStart = sessionStart
    .map((entry) => removeNanoClawMemoryHooks(entry, memoryCommands))
    .filter((entry) => entry !== undefined);
  nextSessionStart.push({
    matcher: memorySessionHook.sources.join('|'),
    hooks: [{ type: 'command', command: memorySessionHook.command, timeout: 10 }],
  });
  hooks.SessionStart = nextSessionStart;
  fs.writeFileSync(hooksJsonPath, JSON.stringify(hooksConfig, null, 2) + '\n');
}

function readHooksConfig(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  if (!isRecord(parsed)) {
    throw new Error(`${filePath} must contain a JSON object`);
  }
  return parsed;
}

function objectProperty(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  if (value === undefined) {
    const created: Record<string, unknown> = {};
    parent[key] = created;
    return created;
  }
  if (!isRecord(value)) {
    throw new Error(`Codex hooks config property '${key}' must be an object`);
  }
  return value;
}

function arrayProperty(parent: Record<string, unknown>, key: string): unknown[] {
  const value = parent[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Codex hooks config property '${key}' must be an array`);
  }
  return value;
}

function removeNanoClawMemoryHooks(value: unknown, commands: ReadonlySet<string>): unknown {
  if (!isRecord(value) || !Array.isArray(value.hooks)) return value;
  const remaining = value.hooks.filter((hook) => {
    if (!isRecord(hook)) return true;
    return typeof hook.command !== 'string' || !commands.has(hook.command);
  });
  return remaining.length > 0 ? { ...value, hooks: remaining } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function buildCodexProcessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const key of CODEX_ENV_ALLOWLIST) {
    const value = env[key];
    if (value !== undefined) next[key] = value;
  }
  if (!next.CODEX_HOME) next.CODEX_HOME = next.HOME ? path.join(next.HOME, '.codex') : '/home/node/.codex';
  if (!next.HOME) next.HOME = '/home/node';
  return next;
}

export function tomlBasicString(value: string): string {
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error(`MCP config value contains newline: ${JSON.stringify(value.slice(0, 40))}`);
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function sendCodexError(server: AppServer, id: number | string, message: string, data?: unknown): void {
  try {
    server.process.stdin!.write(JSON.stringify({ id, error: { code: -32000, message, data } }) + '\n');
  } catch (err) {
    log(`[send-error] error id=${id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return 'id' in msg && ('result' in msg || 'error' in msg) && !('method' in msg);
}

function isServerRequest(msg: JsonRpcMessage): msg is JsonRpcServerRequest {
  return 'id' in msg && 'method' in msg;
}
