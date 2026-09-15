/**
 * The interactive exec over the daemon's API against a fake daemon on a
 * unix socket: create, the hijacked start, raw bytes both ways under a TTY,
 * resize, the exit code, stdout/stderr demultiplexing without a TTY, and
 * the daemon's own messages on failure. Plus where the socket is found.
 */
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Cli } from './cli.js';
import { demultiplex, dockerExecStream, resolveDockerSocket } from './docker-api.js';

const SOCKET = `/tmp/nanoclaw-docker-api-${process.pid}.sock`;

interface FakeDaemon {
  server: http.Server;
  execs: Map<string, { container: string; body: Record<string, unknown> }>;
  resizes: { id: string; h: string; w: string }[];
  exitCode: number;
  upgrade: boolean;
  /** Hijacked sockets, which the http server no longer tracks. */
  sockets: Set<import('node:stream').Duplex>;
}

function frame(type: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function startFakeDaemon(): Promise<FakeDaemon> {
  const daemon: FakeDaemon = {
    server: http.createServer(),
    execs: new Map(),
    resizes: [],
    exitCode: 7,
    upgrade: true,
    sockets: new Set(),
  };
  let next = 1;
  daemon.server.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://docker');
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>) : {};
      const json = (status: number, value: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      let m: RegExpMatchArray | null;
      if (req.method === 'POST' && (m = url.pathname.match(/^\/containers\/([^/]+)\/exec$/))) {
        const container = decodeURIComponent(m[1]);
        if (container === 'missing') return json(404, { message: 'No such container: missing' });
        const id = `exec-${next++}`;
        daemon.execs.set(id, { container, body });
        return json(201, { Id: id });
      }
      if (req.method === 'POST' && (m = url.pathname.match(/^\/exec\/([^/]+)\/resize$/))) {
        daemon.resizes.push({ id: m[1], h: url.searchParams.get('h') ?? '', w: url.searchParams.get('w') ?? '' });
        return json(200, {});
      }
      if (req.method === 'GET' && (m = url.pathname.match(/^\/exec\/([^/]+)\/json$/))) {
        return json(200, { Running: false, ExitCode: daemon.exitCode });
      }
      if (req.method === 'POST' && url.pathname.match(/^\/exec\/([^/]+)\/start$/)) {
        // A daemon that does not upgrade (the client must treat this as failure).
        return json(200, { message: 'streamed without upgrade' });
      }
      json(404, { message: `page not found: ${req.method} ${url.pathname}` });
    });
  });
  daemon.server.on('upgrade', (req, socket, head) => {
    daemon.sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => daemon.sockets.delete(socket));
    const m = (req.url ?? '').match(/^\/exec\/([^/]+)\/start$/);
    const exec = m ? daemon.execs.get(m[1]) : undefined;
    if (!exec || !daemon.upgrade) {
      socket.end('HTTP/1.1 404 Not Found\r\ncontent-type: application/json\r\n\r\n{"message":"no such exec"}');
      return;
    }
    socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    void head;
    if (exec.body.Tty) {
      socket.write('ready\r\n');
      socket.on('data', (data: Buffer) => {
        const input = data.toString();
        if (input.includes('quit')) socket.end();
        else socket.write(input.toUpperCase());
      });
    } else {
      socket.write(frame(1, 'out\n'));
      socket.write(frame(2, 'err\n'));
      socket.end();
    }
  });
  return new Promise((resolve) => daemon.server.listen(SOCKET, () => resolve(daemon)));
}

async function read(stream: NodeJS.ReadableStream, until: (text: string) => boolean): Promise<string> {
  let text = '';
  return new Promise((resolve) => {
    const onData = (chunk: Buffer): void => {
      text += chunk.toString();
      if (until(text)) {
        stream.off('data', onData);
        resolve(text);
      }
    };
    stream.on('data', onData);
    stream.on('end', () => resolve(text));
  });
}

let daemon: FakeDaemon;

beforeEach(async () => {
  daemon = await startFakeDaemon();
});

afterEach(async () => {
  for (const socket of daemon.sockets) socket.destroy();
  daemon.server.closeAllConnections();
  await new Promise<void>((resolve) => daemon.server.close(() => resolve()));
});

describe('dockerExecStream', () => {
  it('creates a TTY exec sized from the caller, hijacks it, pumps bytes both ways, resizes, and reports the exit code', async () => {
    const exec = await dockerExecStream(SOCKET, 'ncl-sess-1', ['sh', '-c', 'tmux attach'], {
      tty: true,
      cols: 80,
      rows: 24,
    });
    const created = daemon.execs.get('exec-1')!;
    expect(created.container).toBe('ncl-sess-1');
    expect(created.body).toMatchObject({
      Tty: true,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Cmd: ['sh', '-c', 'tmux attach'],
      ConsoleSize: [24, 80],
    });
    expect(daemon.resizes).toEqual([{ id: 'exec-1', h: '24', w: '80' }]);
    expect(exec.stderr).toBeUndefined();

    expect(await read(exec.stdout, (t) => t.includes('ready'))).toContain('ready\r\n');
    const echoed = read(exec.stdout, (t) => t.includes('HELLO'));
    exec.stdin.write('hello');
    expect(await echoed).toContain('HELLO');

    await exec.resize(120, 40);
    expect(daemon.resizes.at(-1)).toEqual({ id: 'exec-1', h: '40', w: '120' });

    exec.stdin.write('quit');
    expect(await exec.exited).toBe(7);
  });

  it('demultiplexes stdout and stderr without a TTY and ends both', async () => {
    const exec = await dockerExecStream(SOCKET, 'ncl-sess-2', ['ls'], { tty: false });
    expect(daemon.execs.get('exec-1')!.body).toMatchObject({ Tty: false, Cmd: ['ls'] });
    expect(daemon.execs.get('exec-1')!.body.ConsoleSize).toBeUndefined();
    expect(daemon.resizes).toEqual([]);
    const [out, err] = await Promise.all([read(exec.stdout, () => false), read(exec.stderr!, () => false)]);
    expect(out).toBe('out\n');
    expect(err).toBe('err\n');
    expect(await exec.exited).toBe(7);
  });

  it('hangs up on close and reports the daemon’s messages on failure', async () => {
    const exec = await dockerExecStream(SOCKET, 'ncl-sess-3', ['sh'], { tty: true });
    daemon.exitCode = 129;
    exec.close();
    expect(await exec.exited).toBe(129);

    await expect(dockerExecStream(SOCKET, 'missing', ['sh'], { tty: true })).rejects.toThrow(
      /docker exec create failed: No such container: missing/,
    );
    daemon.upgrade = false;
    await expect(dockerExecStream(SOCKET, 'ncl-sess-4', ['sh'], { tty: true })).rejects.toThrow(
      /docker exec start failed/,
    );
  });
});

describe('demultiplex', () => {
  it('reassembles frames split across chunks', async () => {
    const input = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    demultiplex(input, stdout, stderr);
    const bytes = Buffer.concat([frame(1, 'hello '), frame(2, 'warn'), frame(1, 'world')]);
    for (let i = 0; i < bytes.length; i += 5) input.write(bytes.subarray(i, i + 5));
    input.end();
    const [out, err] = await Promise.all([read(stdout, () => false), read(stderr, () => false)]);
    expect(out).toBe('hello world');
    expect(err).toBe('warn');
  });
});

describe('resolveDockerSocket', () => {
  const cli = (host: string): Cli => ({ bin: 'docker', run: vi.fn(() => `${host}\n`), start: vi.fn() });

  it('prefers DOCKER_HOST, then the system socket, then Docker Desktop’s, then the CLI context', () => {
    const none = (): boolean => false;
    expect(resolveDockerSocket({ env: { DOCKER_HOST: 'unix:///srv/docker.sock' }, exists: none })).toBe(
      '/srv/docker.sock',
    );
    expect(resolveDockerSocket({ env: {}, exists: (p) => p === '/var/run/docker.sock' })).toBe('/var/run/docker.sock');
    expect(
      resolveDockerSocket({ env: {}, homeDir: '/home/a', exists: (p) => p === '/home/a/.docker/run/docker.sock' }),
    ).toBe('/home/a/.docker/run/docker.sock');
    expect(resolveDockerSocket({ env: {}, exists: none, cli: cli('unix:///ctx/docker.sock') })).toBe(
      '/ctx/docker.sock',
    );
    expect(resolveDockerSocket({ env: {}, exists: none, cli: cli('tcp://10.0.0.1:2375') })).toBe(
      '/var/run/docker.sock',
    );
    expect(resolveDockerSocket({ env: { DOCKER_HOST: 'tcp://x' }, exists: none })).toBe('/var/run/docker.sock');
  });
});
