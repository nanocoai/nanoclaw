/**
 * Host-side socket listener. Started from src/index.ts, accepts one frame
 * per connection, calls dispatch() with caller='host', writes the response
 * frame, closes.
 *
 * Lives at data/ncl.sock (separate from data/cli.sock, which the existing
 * chat-style CLI channel adapter owns). Socket file is chmod 0600 — only
 * the user that started the host can connect.
 */
import fs from 'fs';
import net from 'net';

import { log } from '../log.js';
import { dispatch } from './dispatch.js';
import type { CallerContext, RequestFrame, ResponseFrame } from './frame.js';
import { DEFAULT_SOCKET_PATH } from './socket-client.js';

let server: net.Server | null = null;

const PROBE_TIMEOUT_MS = 1000;

/**
 * Is a live server accepting on this socket path? Used before stale-socket
 * cleanup so a second host started in the same checkout refuses to take over
 * a running host's socket instead of silently unlinking it (after which every
 * `ncl` call would route to the newcomer while the original keeps running).
 * No verdict within the timeout counts as live — when unsure, never steal.
 */
function probeLiveServer(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createConnection(socketPath);
    const done = (live: boolean): void => {
      probe.destroy();
      resolve(live);
    };
    probe.once('connect', () => done(true));
    probe.once('error', () => done(false));
    probe.setTimeout(PROBE_TIMEOUT_MS, () => done(true));
  });
}

export async function startCliServer(socketPath: string = DEFAULT_SOCKET_PATH): Promise<void> {
  // Stale-socket cleanup — a previous run that crashed may have left the
  // file behind, and net.createServer refuses to bind to an existing path.
  // Only a socket nobody answers is stale: a live listener means another
  // host instance owns this path, and startup must fail rather than steal it.
  if (fs.existsSync(socketPath)) {
    if (await probeLiveServer(socketPath)) {
      throw new Error(
        `another host instance is already serving ncl at ${socketPath} — ` +
          `refusing to take over its socket. Stop the other instance ` +
          `(or remove the file if you are certain none is running) and restart.`,
      );
    }
    try {
      fs.unlinkSync(socketPath);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') {
        log.warn('Failed to unlink stale ncl socket (will try to bind anyway)', { socketPath, err });
      }
    }
  }

  const s = net.createServer((conn) => handleConnection(conn));
  server = s;
  await new Promise<void>((resolve, reject) => {
    s.once('error', reject);
    s.listen(socketPath, () => {
      try {
        fs.chmodSync(socketPath, 0o600);
      } catch (err) {
        log.warn('Failed to chmod ncl socket (continuing)', { socketPath, err });
      }
      log.info('ncl CLI server listening', { socketPath });
      resolve();
    });
  });
}

export async function stopCliServer(): Promise<void> {
  if (!server) return;
  const s = server;
  server = null;
  await new Promise<void>((resolve) => s.close(() => resolve()));
}

function handleConnection(conn: net.Socket): void {
  let buffer = '';
  conn.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      void handleFrame(conn, line);
    }
  });
  conn.on('error', (err) => {
    log.warn('ncl CLI server connection error', { err });
  });
}

async function handleFrame(conn: net.Socket, line: string): Promise<void> {
  let req: RequestFrame;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isRequestFrame(parsed)) throw new Error('bad request shape');
    req = parsed;
  } catch (e) {
    write(conn, {
      id: 'unknown',
      ok: false,
      error: {
        code: 'transport-error',
        message: `bad frame: ${e instanceof Error ? e.message : String(e)}`,
      },
    });
    return;
  }

  // Host caller — connecting to data/ncl.sock requires file-system access
  // to a 0600 socket owned by the host user, so we treat the socket path
  // itself as the auth boundary.
  const ctx: CallerContext = { caller: 'host' };
  const res = await dispatch(req, ctx);
  write(conn, res);
}

function write(conn: net.Socket, frame: ResponseFrame): void {
  try {
    conn.write(JSON.stringify(frame) + '\n');
    conn.end();
  } catch (err) {
    log.warn('Failed to write ncl CLI response', { err });
  }
}

function isRequestFrame(x: unknown): x is RequestFrame {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.command === 'string' && typeof o.args === 'object' && o.args !== null;
}
