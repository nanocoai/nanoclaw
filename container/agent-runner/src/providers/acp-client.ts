/**
 * Agent Client Protocol (ACP) provider.
 *
 * ACP (https://agentclientprotocol.com) is a JSON-RPC 2.0 protocol where
 * NanoClaw acts as the client, spawning an AI agent subprocess and
 * communicating over stdin/stdout, or connecting to one over TCP.
 *
 * Per-turn flow: initialize → session/new (or resume) → session/prompt →
 *   collect session/update notifications → result
 *
 * Session resume: if input.continuation is set, session/new is skipped and
 * the existing sessionId is reused. Falls back to session/new if the agent
 * no longer knows the session (e.g. server restarted).
 *
 * Config (injected by host-side src/providers/acp-client.ts):
 *   ACP_CLIENT_CMD   — JSON array: command + args for subprocess mode
 *   ACP_CLIENT_HOST  — hostname for TCP mode
 *   ACP_CLIENT_PORT  — port for TCP mode (used with ACP_CLIENT_HOST)
 */
import fs from 'fs';
import path from 'path';
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

// ── JSON-RPC 2.0 types ──────────────────────────────────────────────────────

interface RpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface RpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface RpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

function isRpcResponse(msg: RpcMessage): msg is RpcResponse {
  return 'id' in msg && ('result' in msg || 'error' in msg) && !('method' in msg);
}

function isRpcRequest(msg: RpcMessage): msg is RpcRequest {
  return 'id' in msg && 'method' in msg;
}

// ── Line reader ─────────────────────────────────────────────────────────────

export class LineReader {
  private buf = '';
  private lines: string[] = [];
  private waiters: Array<(line: string | null) => void> = [];
  private ended = false;

  feed(chunk: string): void {
    this.buf += chunk;
    const parts = this.buf.split('\n');
    this.buf = parts.pop()!;
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (this.waiters.length > 0) this.waiters.shift()!(trimmed);
      else this.lines.push(trimmed);
    }
  }

  end(): void {
    this.ended = true;
    for (const w of this.waiters) w(null);
    this.waiters = [];
  }

  readLine(): Promise<string | null> {
    if (this.lines.length > 0) return Promise.resolve(this.lines.shift()!);
    if (this.ended) return Promise.resolve(null);
    return new Promise(resolve => this.waiters.push(resolve));
  }
}

// ── Transport interface ─────────────────────────────────────────────────────

export interface AcpTransport {
  write(msg: string): void;
  readLine(): Promise<string | null>;
  close(): void;
}

// ── Subprocess transport ────────────────────────────────────────────────────

export async function connectSubprocess(cmd: string[]): Promise<AcpTransport> {
  const [prog, ...args] = cmd;
  const proc = Bun.spawn([prog, ...args], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const reader = new LineReader();
  const dec = new TextDecoder();

  (async () => {
    const r = proc.stdout.getReader();
    try {
      while (true) {
        const { value, done } = await r.read();
        if (done) break;
        reader.feed(dec.decode(value));
      }
    } finally {
      reader.end();
    }
  })().catch(() => reader.end());

  return {
    write(msg) {
      proc.stdin.write(msg + '\n');
      proc.stdin.flush();
    },
    readLine: () => reader.readLine(),
    close() { try { proc.kill(); } catch { /* already dead */ } },
  };
}

// ── TCP transport ───────────────────────────────────────────────────────────

export async function connectTcp(host: string, port: number): Promise<AcpTransport> {
  const reader = new LineReader();
  const dec = new TextDecoder();

  return new Promise<AcpTransport>((resolve, reject) => {
    Bun.connect({
      hostname: host,
      port,
      socket: {
        open(socket) {
          resolve({
            write(msg) { socket.write(msg + '\n'); },
            readLine: () => reader.readLine(),
            close() { try { socket.end(); } catch { /* ignore */ } },
          });
        },
        data(_socket, data) { reader.feed(dec.decode(data)); },
        close() { reader.end(); },
        error(_socket, err) { reader.end(); reject(err); },
      },
    }).catch(reject);
  });
}

// ── JSON-RPC dispatcher ─────────────────────────────────────────────────────

export class JsonRpcDispatcher {
  private idSeq = 1;
  private pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: unknown) => void }>();
  private notifHandlers = new Map<string, (params: unknown) => void>();
  private reqHandlers = new Map<string, (params: unknown) => Promise<unknown>>();

  constructor(private transport: AcpTransport) {}

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.idSeq++;
    this.transport.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notifHandlers.set(method, handler);
  }

  onRequest(method: string, handler: (params: unknown) => Promise<unknown>): void {
    this.reqHandlers.set(method, handler);
  }

  dispatch(line: string): void {
    let msg: RpcMessage;
    try { msg = JSON.parse(line) as RpcMessage; } catch { return; }

    if (isRpcResponse(msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    } else if (isRpcRequest(msg)) {
      const handler = this.reqHandlers.get(msg.method);
      const respond = (result: unknown) =>
        this.transport.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      const respondErr = (code: number, message: string) =>
        this.transport.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code, message } }));
      if (handler) {
        handler(msg.params).then(respond).catch(e => respondErr(-32603, e instanceof Error ? e.message : String(e)));
      } else {
        respondErr(-32601, `Method not found: ${msg.method}`);
      }
    } else {
      const p = msg as RpcNotification;
      if ('method' in p) this.notifHandlers.get(p.method)?.(p.params);
    }
  }

  async pumpLoop(): Promise<void> {
    while (true) {
      const line = await this.transport.readLine();
      if (line === null) {
        for (const { reject } of this.pending.values()) reject(new Error('Connection closed'));
        this.pending.clear();
        return;
      }
      this.dispatch(line);
    }
  }
}

// ── Workspace path guard ────────────────────────────────────────────────────

const WORKSPACE = '/workspace';

function resolveWorkspacePath(filePath: string): string | null {
  // Support both spec field name ("path") and legacy "uri" (file:// or plain path)
  let p = filePath;
  if (p.startsWith('file://')) p = decodeURIComponent(p.slice(7));
  if (!path.isAbsolute(p)) p = path.join(WORKSPACE, p);
  const resolved = path.resolve(p);
  if (resolved !== WORKSPACE && !resolved.startsWith(WORKSPACE + path.sep)) return null;
  return resolved;
}

// ── stopReason classification ───────────────────────────────────────────────

// Reasons that mean the agent produced output and is done — treat as result.
// "done" is not in the spec but our test server uses it for compat.
const STOP_REASON_SUCCESS = new Set(['end_turn', 'done', 'max_tokens', 'max_turn_requests']);

// ── XML stripping ──────────────────────────────────────────────────────────
// NanoClaw formats conversation history as XML for Claude. External ACP agents
// are not Claude — strip to plain text so they see a clean conversation.
function stripXmlMessages(prompt: string): string {
  if (!prompt.includes('<message') && !prompt.includes('<context')) return prompt;
  const lines: string[] = [];
  const messageRe = /<message[^>]*\ssender="([^"]*)"[^>]*>([\s\S]*?)<\/message>/g;
  let match: RegExpExecArray | null;
  while ((match = messageRe.exec(prompt)) !== null) {
    const text = match[2].replace(/<[^>]+>/g, '').trim();
    if (text) lines.push(text);
  }
  if (lines.length === 0) return prompt;
  const TRIGGER_RE = /^[a-z][a-z0-9_-]*:\s*/i;
  return lines.map((l) => l.replace(TRIGGER_RE, '')).join('\n');
}

// ── Injectable transport factory (overridden in tests) ──────────────────────

export const _test = {
  createTransport: async (cmd: string[] | null, host: string | null, port: number | null): Promise<AcpTransport> => {
    if (cmd) return connectSubprocess(cmd);
    return connectTcp(host!, port!);
  },
};

// ── Provider ────────────────────────────────────────────────────────────────

function log(msg: string): void {
  console.error(`[acp-client-provider] ${msg}`);
}

export class AcpClientProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly cmd: string[] | null;
  private readonly host: string | null;
  private readonly port: number | null;

  constructor(_options: ProviderOptions = {}) {
    const cmdEnv = process.env.ACP_CLIENT_CMD;
    this.cmd = cmdEnv ? (JSON.parse(cmdEnv) as string[]) : null;
    this.host = process.env.ACP_CLIENT_HOST || null;
    this.port = process.env.ACP_CLIENT_PORT ? parseInt(process.env.ACP_CLIENT_PORT, 10) : null;

    if (!this.cmd && !(this.host && this.port)) {
      throw new Error('ACP_CLIENT_CMD or ACP_CLIENT_HOST+ACP_CLIENT_PORT required for acp-client provider');
    }
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /session.*not found|invalid state|connection closed/i.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    let aborted = false;
    let activeTransport: AcpTransport | null = null;

    const { cmd, host, port } = this;
    const systemInstructions = input.systemContext?.instructions;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      if (aborted) return;

      // ── Connect ──────────────────────────────────────────────────────────
      let transport: AcpTransport;
      try {
        transport = await _test.createTransport(cmd, host, port);
      } catch (e) {
        yield { type: 'error', message: `Failed to connect to ACP agent: ${e instanceof Error ? e.message : String(e)}`, retryable: true };
        return;
      }
      activeTransport = transport;

      const rpc = new JsonRpcDispatcher(transport);

      // Serve fs/ requests from /workspace — accept both "path" (spec) and
      // "uri" (legacy) so both compliant agents and our test server work.
      rpc.onRequest('fs/read_text_file', async (params) => {
        const p = params as { sessionId?: string; path?: string; uri?: string; line?: number; limit?: number };
        const filePath = p.path ?? p.uri ?? '';
        const resolved = resolveWorkspacePath(filePath);
        if (!resolved) throw new Error(`Path outside workspace: ${filePath}`);
        const raw = fs.readFileSync(resolved, 'utf-8');
        // Apply optional line/limit slicing
        if (p.line !== undefined || p.limit !== undefined) {
          const lines = raw.split('\n');
          const start = Math.max(0, (p.line ?? 1) - 1);
          const slice = p.limit !== undefined ? lines.slice(start, start + p.limit) : lines.slice(start);
          return { content: slice.join('\n') };
        }
        return { content: raw };
      });

      rpc.onRequest('fs/write_text_file', async (params) => {
        const p = params as { sessionId?: string; path?: string; uri?: string; content: string };
        const filePath = p.path ?? p.uri ?? '';
        const resolved = resolveWorkspacePath(filePath);
        if (!resolved) throw new Error(`Path outside workspace: ${filePath}`);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, p.content, 'utf-8');
        return null;
      });

      // Accumulate streamed message chunks. Accept both "sessionUpdate" (spec)
      // and "kind" (legacy test server) as the discriminator field name.
      const chunks: string[] = [];
      rpc.onNotification('session/update', (params) => {
        const p = params as { update?: { sessionUpdate?: string; kind?: string; content?: unknown } };
        const updateType = p?.update?.sessionUpdate ?? p?.update?.kind;
        if (updateType !== 'agent_message_chunk') {
          // plan, tool_call, tool_call_update — log but do not error
          if (updateType) log(`session/update: ${updateType} (not collected)`);
          return;
        }
        const c = p.update!.content as { content?: Array<{ type: string; text?: string }> } | undefined;
        const text = (c?.content ?? [])
          .filter(b => b.type === 'text')
          .map(b => b.text ?? '')
          .join('');
        if (text) chunks.push(text);
      });

      rpc.pumpLoop().catch(e => log(`pumpLoop closed: ${e instanceof Error ? e.message : String(e)}`));

      try {
        // ── initialize ────────────────────────────────────────────────────
        if (aborted) { transport.close(); return; }
        yield { type: 'activity' };

        const initResult = (await rpc.request('initialize', {
          protocolVersion: 1,
          clientInfo: { name: 'nanoclaw', title: 'NanoClaw', version: '1.0.0' },
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: false,
          },
          authMethods: [],
        })) as { protocolVersion?: number; agentCapabilities?: unknown };

        if (initResult.protocolVersion !== undefined && initResult.protocolVersion !== 1) {
          yield { type: 'error', message: `ACP agent uses unsupported protocol version ${initResult.protocolVersion}`, retryable: false };
          return;
        }

        // We serve fs/ requests regardless of what the agent declares — the agent
        // calls US for file access, not the other way around. Warn if the agent
        // didn't advertise fs support so unexpected rejections are easier to diagnose.
        const agentCaps = initResult.agentCapabilities as { fs?: { readTextFile?: boolean; writeTextFile?: boolean } } | undefined;
        if (agentCaps && !agentCaps.fs?.readTextFile && !agentCaps.fs?.writeTextFile) {
          log('Warning: agent did not declare fs capabilities — fs/ calls may be rejected');
        }

        // ── session: resume or new ────────────────────────────────────────
        if (aborted) { transport.close(); return; }

        // Strip NanoClaw XML conversation format — external agents are not Claude
        // and don't understand the XML wrapper. System instructions are injected
        // as a plain <system> block that the test server (and real agents) can parse.
        const cleanPrompt = stripXmlMessages(input.prompt);
        const promptText = systemInstructions
          ? `<system>\n${systemInstructions}\n</system>\n\n${cleanPrompt}`
          : cleanPrompt;

        // ── session: resume or new ────────────────────────────────────────
        if (aborted) { transport.close(); return; }

        let sessionId: string;
        const isResume = !!input.continuation;
        if (isResume) {
          sessionId = input.continuation!;
          log(`resuming session: ${sessionId}`);
        } else {
          const sessionResult = (await rpc.request('session/new', {
            cwd: WORKSPACE,
            mcpServers: [],
          })) as { sessionId: string };
          sessionId = sessionResult.sessionId;
          log(`session created: ${sessionId}`);
          // Emit init immediately so the poll-loop persists the sessionId even
          // if the container dies before the prompt response arrives.
          yield { type: 'init', continuation: sessionId };
        }

        // ── session/prompt ────────────────────────────────────────────────
        if (aborted) { transport.close(); return; }
        yield { type: 'activity' };

        let promptResult: { content?: Array<{ type: string; text?: string }>; stopReason: string };
        try {
          promptResult = (await rpc.request('session/prompt', {
            sessionId,
            prompt: [{ type: 'text', text: promptText }],
          })) as typeof promptResult;
          // Resume succeeded — emit init with the resumed session id.
          if (isResume) yield { type: 'init', continuation: sessionId };
        } catch (e) {
          // Stale continuation — agent lost the session (e.g. server restarted).
          // Transparently create a fresh session and retry without surfacing an error.
          if (isResume && e instanceof Error && /session.*not found|no conversation/i.test(e.message)) {
            log(`session ${sessionId} not found — creating fresh session`);
            const sessionResult = (await rpc.request('session/new', {
              cwd: WORKSPACE,
              mcpServers: [],
            })) as { sessionId: string };
            sessionId = sessionResult.sessionId;
            yield { type: 'init', continuation: sessionId };
            promptResult = (await rpc.request('session/prompt', {
              sessionId,
              prompt: [{ type: 'text', text: promptText }],
            })) as typeof promptResult;
          } else {
            throw e;
          }
        }

        const { stopReason } = promptResult;

        if (stopReason === 'cancelled') {
          yield { type: 'error', message: 'ACP session prompt was cancelled', retryable: false };
          return;
        }

        if (stopReason === 'refusal') {
          yield { type: 'error', message: 'ACP agent refused to respond', retryable: false };
          return;
        }

        // All other stopReasons (end_turn, done, max_tokens, max_turn_requests)
        // mean the agent produced output — return whatever we collected.
        if (!STOP_REASON_SUCCESS.has(stopReason)) {
          log(`Unknown stopReason: ${stopReason} — treating as result`);
        }

        const inlineText = (promptResult.content ?? [])
          .filter(b => b.type === 'text')
          .map(b => b.text ?? '')
          .join('');

        const fullText = [...chunks, inlineText].join('').trim() || null;
        log(`session ${sessionId} done (${stopReason}), ${fullText?.length ?? 0} chars`);

        // Best-effort close: transport shuts down immediately after, so the
        // agent may not receive this if it's slow. Intentional — we don't block.
        rpc.request('session/close', { sessionId }).catch(() => {});

        yield { type: 'result', text: fullText };
      } catch (e) {
        if (!aborted) {
          yield {
            type: 'error',
            message: `ACP client error: ${e instanceof Error ? e.message : String(e)}`,
            retryable: true,
          };
        }
      } finally {
        activeTransport = null;
        transport.close();
      }
    }

    return {
      push: () => { log('push() is a no-op on acp-client — single-turn per connection'); },
      end: () => {},
      events: gen(),
      abort: () => {
        aborted = true;
        activeTransport?.close();
      },
    };
  }
}

registerProvider('acp-client', (opts) => new AcpClientProvider(opts));
