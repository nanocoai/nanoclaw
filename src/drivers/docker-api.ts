/**
 * The slice of the Docker Engine API the driver needs beyond its CLI: an
 * interactive exec whose byte stream the host itself holds. `docker exec -it`
 * gives a terminal to a process the host spawns; a remote terminal session
 * has no process to give it to, so the host creates the exec, starts it
 * with a hijacked connection, pipes bytes both ways, and resizes it as the
 * far terminal changes. With a TTY the stream is raw; without one Docker
 * multiplexes stdout and stderr into framed records, demultiplexed here.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { PassThrough, type Readable, type Writable } from 'node:stream';

import type { Cli } from './cli.js';
import type { SessionExecOptions, SessionExecStream } from './types.js';

/** Where the daemon listens, in order: `DOCKER_HOST`, the system socket, Docker Desktop's, the CLI's context. */
export function resolveDockerSocket({
  env = process.env,
  homeDir = os.homedir(),
  cli,
  exists = fs.existsSync,
}: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  cli?: Cli;
  exists?: (path: string) => boolean;
} = {}): string {
  const fromEnv = env.DOCKER_HOST;
  if (fromEnv?.startsWith('unix://')) return fromEnv.slice('unix://'.length);
  const system = '/var/run/docker.sock';
  if (exists(system)) return system;
  const desktop = `${homeDir}/.docker/run/docker.sock`;
  if (exists(desktop)) return desktop;
  if (cli) {
    try {
      const host = cli
        .run(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { timeoutMs: 5000 })
        .trim();
      if (host.startsWith('unix://')) return host.slice('unix://'.length);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      // No usable context; the system path below is the daemon's own default.
    }
  }
  return system;
}

interface Reply {
  status: number;
  body: string;
}

function request(socketPath: string, method: string, path: string, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath,
        method,
        path,
        // One connection per request: a pooled connection to a daemon that
        // went away (or a different daemon on the same path later) fails
        // with a broken pipe instead of a clean reconnect.
        agent: false,
        headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function daemonMessage(reply: Reply): string {
  try {
    const parsed = JSON.parse(reply.body) as { message?: unknown };
    if (typeof parsed.message === 'string') return parsed.message;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return reply.body.trim() || `status ${reply.status}`;
}

/** Split Docker's non-TTY attach stream (8-byte header: type, 0, 0, 0, size BE) into stdout and stderr. */
export function demultiplex(input: Readable, stdout: Writable, stderr: Writable): void {
  let pending: Buffer = Buffer.alloc(0);
  input.on('data', (chunk: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    for (;;) {
      if (pending.length < 8) return;
      const size = pending.readUInt32BE(4);
      if (pending.length < 8 + size) return;
      const payload = pending.subarray(8, 8 + size);
      (pending[0] === 2 ? stderr : stdout).write(payload);
      pending = pending.subarray(8 + size);
    }
  });
  input.on('end', () => {
    stdout.end();
    stderr.end();
  });
}

const EXIT_POLL_MS = 200;
const EXIT_POLL_ROUNDS = 10;

/** Create and start an exec against `container`, hijacking its stream. */
export async function dockerExecStream(
  socketPath: string,
  container: string,
  command: string[],
  options: SessionExecOptions,
): Promise<SessionExecStream> {
  const created = await request(socketPath, 'POST', `/containers/${encodeURIComponent(container)}/exec`, {
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: options.tty,
    Cmd: command,
    ...(options.env ? { Env: options.env } : {}),
    ...(options.tty && options.cols && options.rows ? { ConsoleSize: [options.rows, options.cols] } : {}),
  });
  if (created.status !== 201) throw new Error(`docker exec create failed: ${daemonMessage(created)}`);
  const { Id: id } = JSON.parse(created.body) as { Id: string };

  const socket = await new Promise<import('node:net').Socket>((resolve, reject) => {
    const payload = JSON.stringify({ Detach: false, Tty: options.tty });
    const req = http.request({
      socketPath,
      method: 'POST',
      path: `/exec/${id}/start`,
      agent: false,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        connection: 'Upgrade',
        upgrade: 'tcp',
      },
    });
    req.on('upgrade', (_res, upgraded, head) => {
      // A late error (the far side gone, a write after hang-up) ends the
      // stream; 'close' follows and the exit code is read from the daemon.
      upgraded.on('error', () => {});
      if (head.length) upgraded.unshift(head);
      resolve(upgraded);
    });
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        reject(
          new Error(
            `docker exec start failed: ${daemonMessage({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })}`,
          ),
        ),
      );
    });
    req.on('error', reject);
    req.end(payload);
  });

  const resize = async (cols: number, rows: number): Promise<void> => {
    const reply = await request(socketPath, 'POST', `/exec/${id}/resize?h=${Math.max(1, rows)}&w=${Math.max(1, cols)}`);
    // A finished exec cannot be resized; that is not an error for the caller.
    if (reply.status >= 500) throw new Error(`docker exec resize failed: ${daemonMessage(reply)}`);
  };

  const exited = new Promise<number>((resolve) => {
    socket.once('close', () => {
      void (async () => {
        for (let round = 0; round < EXIT_POLL_ROUNDS; round++) {
          const reply = await request(socketPath, 'GET', `/exec/${id}/json`).catch(() => undefined);
          if (reply?.status === 200) {
            const state = JSON.parse(reply.body) as { Running?: boolean; ExitCode?: number | null };
            if (!state.Running && typeof state.ExitCode === 'number') return resolve(state.ExitCode);
          }
          await new Promise((wait) => setTimeout(wait, EXIT_POLL_MS));
        }
        resolve(1);
      })();
    });
  });

  let stdout: Readable = socket;
  let stderr: Readable | undefined;
  if (!options.tty) {
    const out = new PassThrough();
    const err = new PassThrough();
    demultiplex(socket, out, err);
    stdout = out;
    stderr = err;
  } else if (options.cols && options.rows) {
    // The initial size may predate the daemon's support for it at create; set it now that the exec runs.
    await resize(options.cols, options.rows).catch(() => {});
  }

  return {
    stdin: socket,
    stdout,
    ...(stderr ? { stderr } : {}),
    resize,
    exited,
    close: () => socket.destroy(),
  };
}
