/**
 * Gemini app-server JSON-RPC transport primitives.
 *
 * Communicates with `gemini app-server` over stdio. This module is just the
 * plumbing — spawn the process, send requests, dispatch responses and
 * notifications. Higher-level semantics (threads, turns, event translation)
 * live in gemini-cli.ts.
 */
import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { createInterface, type Interface as ReadlineInterface } from 'readline';

function log(msg: string): void {
  console.error(`[gemini-app-server] ${msg}`);
}

const INIT_TIMEOUT_MS = 30_000;

/**
 * Errors from `thread/resume` that indicate the thread ID is unusable.
 */
export const STALE_THREAD_RE = /thread\s+not\s+found|unknown\s+thread|thread[_\s]id|no such thread/i;

/**
 * Escape a string for emission inside a TOML basic string (double-quoted).
 */
export function tomlBasicString(value: string): string {
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error(
      `MCP config value contains newline (not supported in config.toml): ${JSON.stringify(value.slice(0, 40))}${value.length > 40 ? '…' : ''}`,
    );
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// ── JSON-RPC types ──────────────────────────────────────────────────────────

let nextRequestId = 1;

interface JsonRpcRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface JsonRpcServerRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification | JsonRpcServerRequest;

function makeRequest(method: string, params: Record<string, unknown>): JsonRpcRequest {
  return { id: nextRequestId++, method, params };
}

function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return 'id' in msg && ('result' in msg || 'error' in msg) && !('method' in msg);
}

function isServerRequest(msg: JsonRpcMessage): msg is JsonRpcServerRequest {
  return 'id' in msg && 'method' in msg;
}

// ── App-server handle ───────────────────────────────────────────────────────

export interface AppServer {
  process: ChildProcess;
  readline: ReadlineInterface;
  pending: Map<number, { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }>;
  notificationHandlers: ((n: JsonRpcNotification) => void)[];
  serverRequestHandlers: ((r: JsonRpcServerRequest) => void)[];
}

export function spawnGeminiAppServer(): AppServer {
  const args = ['--acp', '--skip-trust'];
  // The current Gemini CLI uses --acp for stdio JSON-RPC.
  // Legacy app-server command and -c flag are no longer supported.

  log(`Spawning: gemini ${args.join(' ')}`);
  const proc = spawn('gemini', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HTTPS_PROXY: '',
      https_proxy: '',
      HTTP_PROXY: '',
      http_proxy: '',
      NODE_EXTRA_CA_CERTS: '',
      SSL_CERT_FILE: '',
      GEMINI_FEATURES_USE_LINUX_SANDBOX_BWRAP: 'false',
    },
  });

  const rl = createInterface({ input: proc.stdout! });

  const server: AppServer = {
    process: proc,
    readline: rl,
    pending: new Map(),
    notificationHandlers: [],
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
      msg = JSON.parse(line);
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

  proc.on('error', (err) => {
    log(`[process-error] ${err.message}`);
    for (const [, handler] of server.pending) handler.reject(err);
    server.pending.clear();
  });

  proc.on('exit', (code, signal) => {
    log(`[exit] code=${code} signal=${signal}`);
    const err = new Error(`Gemini app-server exited: code=${code} signal=${signal}`);
    for (const [, handler] of server.pending) handler.reject(err);
    server.pending.clear();
  });

  return server;
}

export function sendGeminiRequest(
  server: AppServer,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<JsonRpcResponse> {
  const req = makeRequest(method, params);
  const line = JSON.stringify(req) + '\n';

  return new Promise<JsonRpcResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.pending.delete(req.id);
      reject(new Error(`Timeout waiting for ${method} response (${timeoutMs}ms)`));
    }, timeoutMs);

    server.pending.set(req.id, {
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
      server.pending.delete(req.id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export function sendGeminiResponse(server: AppServer, id: number, result: unknown): void {
  const line = JSON.stringify({ id, result }) + '\n';
  try {
    server.process.stdin!.write(line);
  } catch (err) {
    log(`[send-error] Failed to send response for id=${id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function killGeminiAppServer(server: AppServer): void {
  try {
    server.readline.close();
    server.process.kill('SIGTERM');
  } catch {
    /* ignore */
  }
}

// ── Auto-approval ───────────────────────────────────────────────────────────

export function attachGeminiAutoApproval(server: AppServer): void {
  server.serverRequestHandlers.push((req) => {
    const method = req.method;
    log(`[approval] ${method} params=${JSON.stringify(req.params)}`);

    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        sendGeminiResponse(server, req.id, { decision: 'accept' });
        break;
      case 'item/permissions/requestApproval':
        sendGeminiResponse(server, req.id, {
          permissions: { fileSystem: { read: ['/'], write: ['/'] }, network: { enabled: true } },
          scope: 'session',
        });
        break;
      case 'session/request_permission': {
        const options = (req.params as any).options || [];
        const optionId = options.find((o: any) => o.optionId === 'proceed_always')?.optionId || 
                         options.find((o: any) => o.optionId === 'proceed_once')?.optionId || 
                         'accept';
        sendGeminiResponse(server, req.id, { optionId });
        break;
      }
      case 'applyPatchApproval':
      case 'execCommandApproval':
        sendGeminiResponse(server, req.id, { decision: 'approved' });
        break;
      case 'item/tool/call': {
        const toolName = (req.params as { tool?: string }).tool || 'unknown';
        log(`[approval] Unexpected dynamic tool call: ${toolName}`);
        sendGeminiResponse(server, req.id, {
          success: false,
          contentItems: [{ type: 'inputText', text: `Tool "${toolName}" is not available. Use MCP tools instead.` }],
        });
        break;
      }
      case 'item/tool/requestUserInput':
      case 'mcpServer/elicitation/request':
        sendGeminiResponse(server, req.id, { input: null });
        break;
      default:
        log(`[approval] Unknown method ${method}, generic accept`);
        sendGeminiResponse(server, req.id, { decision: 'accept' });
        break;
    }
  });
}

// ── High-level helpers ──────────────────────────────────────────────────────

export async function initializeGeminiAppServer(server: AppServer): Promise<void> {
  log('Sending initialize…');
  const resp = await sendGeminiRequest(
    server,
    'initialize',
    {
      protocolVersion: 1,
      clientInfo: { name: 'nanoclaw', version: '1.0.0' },
      capabilities: {
        streaming: true,
        toolConfirmation: false,
      },
    },
    INIT_TIMEOUT_MS,
  );
  if (resp.error) throw new Error(`Initialize failed: ${resp.error.message}`);
  log('Initialize successful');
}

export interface ThreadParams {
  model: string;
  cwd: string;
  sandbox?: string;
  approvalPolicy?: string;
  personality?: string;
  baseInstructions?: string;
}

export async function startOrResumeGeminiSession(
  server: AppServer,
  sessionId: string | undefined,
  params: ThreadParams,
): Promise<string> {
  if (sessionId) {
    log(`Loading session: ${sessionId}`);
    const resp = await sendGeminiRequest(server, 'session/load', {
      sessionId,
      model: params.model,
      cwd: params.cwd,
    });
    if (!resp.error) {
      log(`Session loaded: ${sessionId}`);
      return sessionId;
    }
    // Gemini sessions don't survive container restarts — session/load failure
    // always means the session is gone. Fall through to a fresh session.
    log(`Session ${sessionId} load failed: ${resp.error.message}; starting fresh session.`);
  }

  log('Starting new session…');
  const resp = await sendGeminiRequest(server, 'session/new', {
    sessionId: `nanoclaw-${Date.now()}`,
    model: params.model,
    cwd: params.cwd,
    mcpServers: [],
    ...(params.baseInstructions ? { instructions: params.baseInstructions } : {}),
  });
  if (resp.error) throw new Error(`session/new failed: ${resp.error.message}`);

  const result = resp.result as { sessionId?: string } | undefined;
  const newSessionId = result?.sessionId;
  if (!newSessionId) throw new Error('session/new response missing sessionId');
  log(`New session: ${newSessionId}`);
  return newSessionId;
}

export interface TurnParams {
  sessionId: string;
  inputText: string;
  model?: string;
  cwd?: string;
}

export async function startGeminiTurn(server: AppServer, params: TurnParams): Promise<void> {
  const resp = await sendGeminiRequest(server, 'session/prompt', {
    sessionId: params.sessionId,
    prompt: [{ type: 'text', text: params.inputText }],
  });
  if (resp.error) throw new Error(`session/prompt failed: ${resp.error.message}`);
}

/**
 * Compact a Gemini session.
 */
export async function compactGeminiThread(server: AppServer, sessionId: string): Promise<void> {
  log(`Compacting session: ${sessionId}`);
  const resp = await sendGeminiRequest(server, 'session/compact', { sessionId });
  if (resp.error) {
    log(`Compaction failed: ${resp.error.message}`);
  } else {
    log('Compaction successful');
  }
}

// ── MCP config.toml ─────────────────────────────────────────────────────────

export interface GeminiMcpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export function writeGeminiMcpConfigToml(servers: Record<string, GeminiMcpServer>): void {
  const geminiConfigDir = path.join(process.env.HOME || '/home/node', '.gemini');
  fs.mkdirSync(geminiConfigDir, { recursive: true });
  const configTomlPath = path.join(geminiConfigDir, 'config.toml');

  const lines: string[] = [];
  for (const [name, config] of Object.entries(servers)) {
    lines.push(`[mcp_servers.${name}]`);
    lines.push('type = "stdio"');
    lines.push(`command = ${tomlBasicString(config.command)}`);
    if (config.args && config.args.length > 0) {
      const argsStr = config.args.map(tomlBasicString).join(', ');
      lines.push(`args = [${argsStr}]`);
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
  log(`Wrote MCP config.toml (${Object.keys(servers).length} server(s))`);
}
