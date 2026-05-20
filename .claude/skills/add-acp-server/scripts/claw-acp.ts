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

const VERSION = '2.0.0';
const RECV_TIMEOUT_MS = 60_000;
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
const FS_ROOT = process.env.NANOCLAW_FS_ROOT ?? process.env.HOME ?? '/home';

// ── Line reader ───────────────────────────────────────────────────────────────
// Same pattern as container/agent-runner/src/providers/acp-client.ts:LineReader

class LineReader {
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

// ── Stdout writer ─────────────────────────────────────────────────────────────

function writeAcp(obj: object): void {
  const line = JSON.stringify(obj);
  dbg('→', line);
  process.stdout.write(line + '\n');
}

function respond(id: number, result: object): void {
  writeAcp({ jsonrpc: '2.0', id, result });
}

function respondError(id: number, code: number, message: string): void {
  writeAcp({ jsonrpc: '2.0', id, error: { code, message } });
}

function notify(method: string, params: object): void {
  writeAcp({ jsonrpc: '2.0', method, params });
}

// ── ACP Bridge ────────────────────────────────────────────────────────────────

class AcpBridge {
  private sock: net.Socket | null = null;
  private sockReader: LineReader | null = null;

  async connect(): Promise<void> {
    if (this.sock) return;

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

    this.sock = sock;
    this.sockReader = reader;
    dbg('connected to', SOCK_PATH);
  }

  private sendCli(text: string): void {
    const msg = JSON.stringify({ text }) + '\n';
    dbg('cli→', msg.trimEnd());
    this.sock!.write(msg, 'utf8');
  }

  private async recvCli(): Promise<string> {
    const deadline = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`NanoClaw response timeout after ${RECV_TIMEOUT_MS / 1000}s`)),
        RECV_TIMEOUT_MS,
      )
    );
    return Promise.race([this._recvCliLoop(), deadline]);
  }

  private async _recvCliLoop(): Promise<string> {
    while (true) {
      const line = await this.sockReader!.readLine();
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
    this.sockReader?.end();
    this.sockReader = null;
    try { this.sock?.destroy(); } catch { /* swallow */ }
    this.sock = null;
  }

  // ── ACP method handlers ───────────────────────────────────────────────────

  private handleInitialize(id: number): void {
    respond(id, {
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

  private handleSessionNew(id: number): void {
    respond(id, { sessionId: randomUUID() });
  }

  private async handleSessionPrompt(
    id: number,
    params: Record<string, unknown>,
  ): Promise<void> {
    const blocks = (params.prompt as Array<Record<string, unknown>> | undefined) ?? [];
    const text = blocks
      .filter(b => b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text as string)
      .join('')
      .trim();

    if (!text) {
      respond(id, { stopReason: 'end_turn' });
      return;
    }

    try {
      await this.connect();
      this.sendCli(text);
      const response = await this.recvCli();

      notify('session/update', {
        sessionId: params.sessionId ?? '',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: response },
        },
      });

      respond(id, { stopReason: 'end_turn' });
    } catch (err) {
      this.close();
      respondError(id, -32000, err instanceof Error ? err.message : String(err));
    }
  }

  private handleSessionCancel(id: number): void {
    this.close();
    respond(id, {});
  }

  private handleSessionClose(id: number): void {
    this.close();
    respond(id, {});
  }

  private handleFsReadTextFile(id: number, params: Record<string, unknown>): void {
    const { path: filePath, line: startLine, limit } = params as {
      path?: string;
      sessionId?: string;
      line?: number;
      limit?: number;
    };
    if (!filePath) {
      respondError(id, -32602, 'Missing required param: path');
      return;
    }
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(FS_ROOT + path.sep) && resolved !== FS_ROOT) {
      respondError(id, -32000, `Path outside allowed root (${FS_ROOT}): ${resolved}`);
      return;
    }
    try {
      const raw = fs.readFileSync(resolved, 'utf8');
      if (startLine !== undefined || limit !== undefined) {
        const lines = raw.split('\n');
        const start = Math.max(0, (startLine ?? 1) - 1);
        const slice = limit !== undefined ? lines.slice(start, start + limit) : lines.slice(start);
        respond(id, { content: slice.join('\n') });
      } else {
        respond(id, { content: raw });
      }
    } catch (err) {
      respondError(id, -32000, err instanceof Error ? err.message : String(err));
    }
  }

  // ── Main stdin loop ───────────────────────────────────────────────────────

  async run(): Promise<void> {
    const stdinReader = new LineReader();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => stdinReader.feed(chunk));
    process.stdin.on('end', () => stdinReader.end());

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

        if (method === 'initialize') {
          this.handleInitialize(id!);
        } else if (method === 'session/new') {
          this.handleSessionNew(id!);
        } else if (method === 'session/prompt') {
          await this.handleSessionPrompt(id!, params);
        } else if (method === 'session/cancel') {
          this.handleSessionCancel(id!);
        } else if (method === 'session/close') {
          this.handleSessionClose(id!);
        } else if (method === 'fs/read_text_file') {
          this.handleFsReadTextFile(id!, params);
        } else if (id !== undefined) {
          respondError(id, -32601, `Method not found: ${method}`);
        }
        // Notifications (no id): silently ignored
      }
    } finally {
      this.close();
    }
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

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
