/**
 * Term-audit harness — stands up the REAL production attach path in-process
 * (PtySession over Bun.Terminal + AttachServer on a tmp socket) with the
 * audit probe as the session child, then drives the REAL attach-client.ts
 * subprocess against it two ways:
 *
 *  - pipes mode (stdin.isTTY=false, the `kubectl exec -i` shape) for
 *    scripted byte-exact checks, mirroring attach-client.test.ts's
 *    fakeServer/spawnClient patterns — but against the real server;
 *  - TTY mode: the client wrapped in a harness-owned Bun.Terminal so
 *    stdin.isTTY=true end-to-end (raw mode, connect-resize, SIGWINCH real).
 *
 * Transport-death levers (the kubectl-orphan shape — liveness.ts: the
 * in-container client never sees EOF when the exec transport dies):
 *  - killReadEnd(): closes the harness-side read end of the client's stdout
 *    pipe → the client's next heartbeat write is an immediate EPIPE;
 *  - stopDraining(): stops reading without closing → bytes buffer in the
 *    64KB pipe buffer indefinitely; a 1-byte NUL beat will not fill it in
 *    any realistic window, so detection may NEVER fire. Both modes are
 *    separate matrix rows on purpose.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { AttachServer, type AttachServerOptions } from '../attach-server.js';
import { PtySession } from '../pty-session.js';
import { SESSION_TERM_ENV } from '../term-env.js';

export const CLIENT_PATH = path.join(import.meta.dir, '..', 'attach-client.ts');
export const PROBE_PATH = path.join(import.meta.dir, 'probe.ts');

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(cond: () => boolean, what: string, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

export function tmpSocketPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-term-audit-')), 'attach.sock');
}

/**
 * The env the harness hands the session: the caller's env plus the REAL
 * terminal-shaped values the runner forces (term-env.ts) — the audit's
 * env verdict rows read what production would actually set.
 */
export function auditSessionEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  // Container reality: the runner has no terminal parent, so only what the
  // runner itself forces exists. A developer shell's COLORTERM leaking in
  // would fake the env verdict.
  delete env.COLORTERM;
  Object.assign(env, SESSION_TERM_ENV, extra);
  return env;
}

export interface CountEvent {
  count: number;
  at: number;
}

export interface AuditStack {
  session: PtySession;
  server: AttachServer;
  socketPath: string;
  /** onClientsChanged history with harness timestamps. */
  countEvents: CountEvent[];
  close(): void;
}

export interface StackOptions {
  env?: Record<string, string>;
  replayBytes?: number;
  /** Injected keepalive knobs (deadline/sweep) for deterministic sweep tests. */
  serverOptions?: AttachServerOptions;
}

/** Real PtySession (Bun.Terminal) running the probe + real AttachServer. */
export async function startStack(opts: StackOptions = {}): Promise<AuditStack> {
  const socketPath = tmpSocketPath();
  const session = new PtySession({
    command: process.execPath,
    args: [PROBE_PATH],
    cwd: os.tmpdir(),
    env: auditSessionEnv(opts.env),
    ...(opts.replayBytes !== undefined ? { replayBytes: opts.replayBytes } : {}),
  });
  session.start();

  const countEvents: CountEvent[] = [];
  const server = new AttachServer(
    session,
    socketPath,
    (count) => countEvents.push({ count, at: Date.now() }),
    opts.serverOptions ?? {},
  );
  await server.listen();

  return {
    session,
    server,
    socketPath,
    countEvents,
    close() {
      server.close();
      session.dispose();
    },
  };
}

/** Reassemble the byte stream the probe received from its `[rx <hex>]` echoes. */
export function rxBytes(output: string): Buffer {
  const hex: string[] = [];
  for (const m of output.matchAll(/\[rx ([0-9a-f]*)\]/g)) hex.push(m[1]);
  return Buffer.from(hex.join(''), 'hex');
}

export interface PipeClient {
  child: ReturnType<typeof spawn>;
  /** Raw bytes the client wrote to stdout so far. */
  bytes(): Buffer;
  /** Byte-faithful (latin1) text view of stdout. */
  output(): string;
  /** Bytes the PROBE received, reassembled from the [rx] echoes seen here. */
  rx(): Buffer;
  stderr(): string;
  write(data: Buffer | string): void;
  endStdin(): void;
  /** Transport-death mode A: EPIPE on the client's next stdout write. */
  killReadEnd(): void;
  /** Transport-death mode B: stop draining; bytes buffer, no error, no EOF. */
  stopDraining(): void;
  exited: Promise<number | null>;
  kill(): void;
}

/** The REAL attach client as a subprocess, stdio piped (`kubectl exec -i` shape). */
export function spawnPipeClient(socketPath: string, env: Record<string, string> = {}): PipeClient {
  const child = spawn(process.execPath, [CLIENT_PATH, socketPath], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const out: Buffer[] = [];
  child.stdout!.on('data', (c: Buffer) => out.push(c));
  child.stdout!.on('error', () => {}); // killReadEnd() destroys the parent side
  let err = '';
  child.stderr!.on('data', (c: Buffer) => {
    err += c.toString('utf8');
  });
  child.stdin!.on('error', () => {}); // a dead child must not crash the harness
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  const bytes = () => Buffer.concat(out);
  return {
    child,
    bytes,
    output: () => bytes().toString('latin1'),
    rx: () => rxBytes(bytes().toString('latin1')),
    stderr: () => err,
    write: (data) => void child.stdin!.write(data),
    endStdin: () => child.stdin!.end(),
    killReadEnd: () => child.stdout!.destroy(),
    stopDraining: () => child.stdout!.pause(),
    exited,
    kill: () => void child.kill(),
  };
}

export interface TtyClient {
  /** Types into the operator-side terminal (reaches the client's raw stdin). */
  write(data: Buffer | string): void;
  /** Resizes the operator-side terminal AND delivers SIGWINCH to the client. */
  resize(cols: number, rows: number): void;
  bytes(): Buffer;
  output(): string;
  rx(): Buffer;
  exited: Promise<number>;
  kill(): void;
}

/**
 * The REAL attach client under a harness-owned Bun.Terminal: stdin.isTTY is
 * true inside the client, so raw mode, the connect-time resize, and SIGWINCH
 * forwarding all run for real (the `kubectl exec -it` shape).
 */
export function spawnTtyClient(
  socketPath: string,
  opts: { cols?: number; rows?: number; env?: Record<string, string> } = {},
): TtyClient {
  const out: Buffer[] = [];
  const terminal = new Bun.Terminal({
    cols: opts.cols ?? 100,
    rows: opts.rows ?? 40,
    name: 'xterm-256color',
    data(_t, chunk) {
      out.push(Buffer.from(chunk));
    },
  });
  const proc = Bun.spawn([process.execPath, CLIENT_PATH, socketPath], {
    terminal,
    env: { ...process.env, ...opts.env },
    onExit() {
      if (!terminal.closed) terminal.close();
    },
  });
  const bytes = () => Buffer.concat(out);
  return {
    write: (data) => void terminal.write(data),
    resize: (cols, rows) => {
      terminal.resize(cols, rows);
      // A real operator terminal's kernel routes SIGWINCH to the client via
      // the controlling-terminal machinery; a Bun.Terminal child has no ctty
      // (term-audit finding), so the harness substitutes that one kernel
      // step by signaling the client directly. Everything downstream —
      // the client's winsize read, FRAME_RESIZE, session.resize, the
      // session child's notification — is the real production path.
      try {
        proc.kill('SIGWINCH');
      } catch {
        // client already exited
      }
    },
    bytes,
    output: () => bytes().toString('latin1'),
    rx: () => rxBytes(bytes().toString('latin1')),
    exited: proc.exited,
    kill: () => proc.kill(),
  };
}

/** A raw non-client socket (frames by hand) — for resize-policy and orphan rows. */
export function rawSocket(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath);
    s.on('data', () => {}); // drain the replay/live stream
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}
