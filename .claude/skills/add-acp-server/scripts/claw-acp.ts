#!/usr/bin/env bun
/**
 * claw-acp — NanoClaw ACP server bridge
 *
 * Bridges ACP JSON-RPC 2.0 (stdio) to NanoClaw v2's CLI Unix socket.
 * IDEs like Zed or WebStorm spawn this as a subprocess and use NanoClaw
 * as their AI backend.
 *
 * Usage:
 *   claw-acp              # IDE spawns this; ACP JSON-RPC on stdin/stdout
 *   claw-acp -v           # verbose — log protocol traffic to stderr
 *
 * JetBrains config (~/.jetbrains/acp.json):
 *   { "agent_servers": { "NanoClaw": { "command": "claw-acp" } } }
 *
 * Zed config (~/.config/zed/settings.json):
 *   { "agent_servers": { "NanoClaw": { "type": "custom", "command": "claw-acp" } } }
 *
 * Requires: NanoClaw v2 host running  (systemctl --user start nanoclaw)
 */

import { randomUUID } from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

export const VERSION = '2.0.0';
export const RECV_TIMEOUT_MS = 60_000;
const verbose = process.argv.includes('-v') || process.argv.includes('--verbose');

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  process.stderr.write(
    'claw-acp: NanoClaw ACP server bridge\n\n' +
    'Usage: claw-acp [-v]\n\n' +
    '  -v, --verbose   Log ACP traffic and socket events to stderr\n\n' +
    'IDEs spawn claw-acp as a subprocess and communicate via ACP JSON-RPC 2.0\n' +
    'on stdio. Prompts are forwarded to the NanoClaw CLI socket and routed\n' +
    'through the normal agent pipeline.\n\n' +
    'Set NANOCLAW_DIR to override the auto-detected NanoClaw directory.\n' +
    'Set NANOCLAW_FS_ROOT to restrict fs/ file access (default: $HOME).\n'
  );
  process.exit(0);
}

function dbg(...args: unknown[]): void {
  if (verbose) process.stderr.write('» ' + args.join(' ') + '\n');
}

// ── NanoClaw directory detection ──────────────────────────────────────────────

function findNanoclawDir(): string {
  const envDir = process.env.NANOCLAW_DIR;
  if (envDir) return envDir;

  // Walk up from this script (up to 8 levels) looking for NanoClaw v2 markers.
  // Works whether the script is at scripts/ (normal install) or deep inside a
  // worktree (.claude/worktrees/*/scripts/).
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (
      fs.existsSync(path.join(dir, 'data', 'v2.db')) ||
      fs.existsSync(path.join(dir, 'data', 'cli.sock'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(process.env.HOME ?? '~', 'src', 'nanoclaw');
}

const NANOCLAW_DIR = findNanoclawDir();
const SOCK_PATH = path.join(NANOCLAW_DIR, 'data', 'cli.sock');
export const FS_ROOT = process.env.NANOCLAW_FS_ROOT ?? process.env.HOME ?? '/home';

// ── Line reader ───────────────────────────────────────────────────────────────
// Same pattern as container/agent-runner/src/providers/acp-client.ts:LineReader

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

// ── CLI transport abstraction ─────────────────────────────────────────────────

export interface CliTransport {
  reader: LineReader;
  write: (msg: string) => void;
  close: () => void;
}

// ── ACP Bridge ────────────────────────────────────────────────────────────────

export interface AcpBridgeOpts {
  input?: LineReader;
  output?: (line: string) => void;
  connectCli?: () => Promise<CliTransport>;
  recvTimeoutMs?: number;
  fsRoot?: string;
}

export class AcpBridge {
  private cli: CliTransport | null = null;
  private readonly out: (line: string) => void;
  private readonly recvTimeoutMs: number;
  private readonly fsRoot: string;
  // Outgoing requests we sent to the IDE, waiting for responses
  private readonly pending = new Map<number, (result: unknown, error?: unknown) => void>();
  private nextId = 1000;

  constructor(private readonly opts: AcpBridgeOpts = {}) {
    this.out = opts.output ?? ((line) => process.stdout.write(line + '\n'));
    this.recvTimeoutMs = opts.recvTimeoutMs ?? RECV_TIMEOUT_MS;
    this.fsRoot = opts.fsRoot ?? FS_ROOT;
  }

  // ── Output helpers ────────────────────────────────────────────────────────

  private write(obj: object): void {
    const line = JSON.stringify(obj);
    dbg('→', line);
    this.out(line);
  }

  private respond(id: number, result: object): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  private respondError(id: number, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private notify(method: string, params: object): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  // Send a request to the IDE and wait for its response (e.g. fs/read_text_file)
  private requestIde<T>(method: string, params: object): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (result, error) => {
        if (error) reject(new Error(typeof error === 'object' ? JSON.stringify(error) : String(error)));
        else resolve(result as T);
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  // Resolve resource_link blocks by asking the IDE to read the files
  private async resolveResources(
    blocks: Array<Record<string, unknown>>,
    sessionId: string,
  ): Promise<string> {
    const parts: string[] = [];
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text as string);
      } else if (block.type === 'resource_link' || block.type === 'resource') {
        const uri = (block.uri ?? block.url) as string | undefined;
        if (!uri) continue;
        const filePath = uri.startsWith('file://') ? uri.slice(7) : uri;
        try {
          const result = await this.requestIde<{ content: string }>(
            'fs/read_text_file',
            { sessionId, path: filePath },
          );
          parts.push(`\n---\n${filePath}\n---\n${result.content}`);
        } catch (err) {
          dbg('resource fetch failed:', filePath, err instanceof Error ? err.message : String(err));
        }
      }
    }
    return parts.join('').trim();
  }

  // ── CLI socket ────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.cli) return;

    if (this.opts.connectCli) {
      this.cli = await this.opts.connectCli();
      return;
    }

    if (!fs.existsSync(SOCK_PATH)) {
      throw new Error(
        `NanoClaw CLI socket not found at ${SOCK_PATH}. ` +
          'Is the NanoClaw host running?  Try: systemctl --user start nanoclaw',
      );
    }

    const reader = new LineReader();
    const sock = net.createConnection(SOCK_PATH);

    await new Promise<void>((resolve, reject) => {
      sock.once('connect', resolve);
      sock.once('error', reject);
    });

    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => reader.feed(chunk));
    sock.on('end', () => reader.end());
    sock.on('error', (err: Error) => {
      process.stderr.write(`[claw-acp] socket error: ${err.message}\n`);
      reader.end();
    });

    this.cli = {
      reader,
      write: (msg) => sock.write(msg, 'utf8'),
      close: () => {
        reader.end();
        try { sock.destroy(); } catch { /* swallow */ }
      },
    };
    dbg('connected to', SOCK_PATH);
  }

  private sendCli(text: string): void {
    const msg = JSON.stringify({ text }) + '\n';
    dbg('cli→', msg.trimEnd());
    this.cli!.write(msg);
  }

  private async recvCli(): Promise<string> {
    const deadline = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`NanoClaw response timeout after ${this.recvTimeoutMs / 1000}s`)),
        this.recvTimeoutMs,
      )
    );
    return Promise.race([this._recvCliLoop(), deadline]);
  }

  private async _recvCliLoop(): Promise<string> {
    while (true) {
      const line = await this.cli!.reader.readLine();
      if (line === null) throw new Error('NanoClaw CLI socket closed unexpectedly');
      dbg('cli←', line);
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (typeof obj.text === 'string') return obj.text;
      } catch {
        // skip non-JSON lines
      }
    }
  }

  close(): void {
    this.cli?.close();
    this.cli = null;
  }

  // ── ACP method handlers ───────────────────────────────────────────────────

  handleInitialize(id: number): void {
    this.respond(id, {
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: {
          image: false,
          embeddedContext: false,
        },
      },
      serverInfo: { name: 'nanoclaw', title: 'NanoClaw', version: VERSION },
      authMethods: [],
    });
  }

  handleSessionNew(id: number): void {
    this.respond(id, { sessionId: randomUUID() });
  }

  async handleSessionPrompt(
    id: number,
    params: Record<string, unknown>,
  ): Promise<void> {
    const blocks = (params.prompt as Array<Record<string, unknown>> | undefined) ?? [];
    const sessionId = (params.sessionId as string | undefined) ?? '';
    const text = await this.resolveResources(blocks, sessionId);

    if (!text) {
      this.respond(id, { stopReason: 'end_turn' });
      return;
    }

    try {
      await this.connect();
      this.sendCli(text);
      const response = await this.recvCli();

      this.notify('session/update', {
        sessionId: params.sessionId ?? '',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: response },
        },
      });

      this.respond(id, { stopReason: 'end_turn' });
    } catch (err) {
      this.close();
      this.respondError(id, -32000, err instanceof Error ? err.message : String(err));
    }
  }

  handleSessionCancel(id: number): void {
    this.close();
    this.respond(id, {});
  }

  handleSessionClose(id: number): void {
    this.close();
    this.respond(id, {});
  }

  handleFsReadTextFile(id: number, params: Record<string, unknown>): void {
    const { path: filePath, line: startLine, limit } = params as {
      path?: string;
      sessionId?: string;
      line?: number;
      limit?: number;
    };
    if (!filePath) {
      this.respondError(id, -32602, 'Missing required param: path');
      return;
    }
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(this.fsRoot + path.sep) && resolved !== this.fsRoot) {
      this.respondError(id, -32000, `Path outside allowed root (${this.fsRoot}): ${resolved}`);
      return;
    }
    try {
      const raw = fs.readFileSync(resolved, 'utf8');
      if (startLine !== undefined || limit !== undefined) {
        const lines = raw.split('\n');
        const start = Math.max(0, (startLine ?? 1) - 1);
        const slice = limit !== undefined ? lines.slice(start, start + limit) : lines.slice(start);
        this.respond(id, { content: slice.join('\n') });
      } else {
        this.respond(id, { content: raw });
      }
    } catch (err) {
      this.respondError(id, -32000, err instanceof Error ? err.message : String(err));
    }
  }

  // ── Main stdin loop ───────────────────────────────────────────────────────

  async run(): Promise<void> {
    let stdinReader: LineReader;

    if (this.opts.input) {
      stdinReader = this.opts.input;
    } else {
      stdinReader = new LineReader();
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk: string) => stdinReader.feed(chunk));
      process.stdin.on('end', () => stdinReader.end());
    }

    try {
      while (true) {
        const raw = await stdinReader.readLine();
        if (raw === null) break;
        dbg('←', raw);

        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          continue;
        }

        const id = msg.id as number | undefined;
        const method = msg.method as string | undefined;
        const params = (msg.params ?? {}) as Record<string, unknown>;

        // Response to one of our outgoing requests (e.g. fs/read_text_file we sent to IDE)
        if (id !== undefined && !method && (msg.result !== undefined || msg.error !== undefined)) {
          const handler = this.pending.get(id as number);
          if (handler) {
            this.pending.delete(id as number);
            handler(msg.result, msg.error);
            continue;
          }
        }

        if (method === 'initialize') {
          this.handleInitialize(id!);
        } else if (method === 'session/new') {
          this.handleSessionNew(id!);
        } else if (method === 'session/prompt') {
          // Don't await — the loop must keep running to process IDE responses
          // (e.g. fs/read_text_file replies) while the prompt is in flight.
          this.handleSessionPrompt(id!, params).catch(err =>
            this.respondError(id!, -32000, err instanceof Error ? err.message : String(err))
          );
        } else if (method === 'session/cancel') {
          this.handleSessionCancel(id!);
        } else if (method === 'session/close') {
          this.handleSessionClose(id!);
        } else if (method === 'fs/read_text_file') {
          this.handleFsReadTextFile(id!, params);
        } else if (id !== undefined) {
          this.respondError(id, -32601, `Method not found: ${method}`);
        }
        // Notifications (no id): silently ignored
      }
    } finally {
      this.close();
    }
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

if (import.meta.main) {
  if (process.stdin.isTTY) {
    process.stderr.write('claw-acp: NanoClaw ACP server bridge\n');
    process.stderr.write(`  NanoClaw directory : ${NANOCLAW_DIR}\n`);
    process.stderr.write(`  CLI socket         : ${SOCK_PATH}\n`);
    process.stderr.write(`  File system root   : ${FS_ROOT}\n`);
    process.stderr.write('  Waiting for ACP JSON-RPC on stdin… (Ctrl-C to exit)\n\n');
    process.stderr.write('  Quick test — paste these lines one at a time:\n');
    process.stderr.write(
      '  {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientInfo":{"name":"test"},"capabilities":{}}}\n',
    );
    process.stderr.write(
      '  {"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/tmp","mcpServers":[]}}\n',
    );
    process.stderr.write(
      '  {"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"s1","prompt":[{"type":"text","text":"Hello!"}]}}\n\n',
    );
  }

  await new AcpBridge().run();
}
