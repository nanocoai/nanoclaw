/**
 * Attach client (D20, D22): the exit-code contract (detach vs server-close
 * vs transport-error), pre-connect stdin buffering, and the outbound-only
 * transport heartbeat.
 *
 * Subprocess tests run the REAL client (`bun attach-client.ts <socket>`)
 * against a real unix-socket server — the client's whole job is wiring
 * process stdio to a socket, so an in-process harness would fake away
 * exactly the pipes under test (the EPIPE path most of all).
 */
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { describe, it, expect, afterEach } from 'bun:test';

import { classifyAttachSocketError, DEFAULT_HEARTBEAT_MS, EXIT_DETACH, EXIT_NO_SOCKET, EXIT_SERVER_CLOSED, EXIT_TRANSPORT_ERROR, resolveHeartbeatMs } from './attach-client.js';
import { DETACH_KEY, FRAME_DATA, FRAME_DETACH, FRAME_PING, FrameParser, type Frame } from './protocol.js';

const CLIENT_PATH = path.join(import.meta.dir, 'attach-client.ts');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, what: string, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

function tmpSocketPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-attach-client-')), 'attach.sock');
}

/** Minimal attach-server stand-in: records client→server frames, exposes the raw socket. */
function fakeServer(socketPath: string) {
  const frames: Frame[] = [];
  let conn: net.Socket | null = null;
  const server = net.createServer((socket) => {
    conn = socket;
    const parser = new FrameParser();
    socket.on('data', (c) => frames.push(...parser.push(c)));
    socket.on('error', () => {});
  });
  const listening = new Promise<void>((r) => server.listen(socketPath, () => r()));
  return {
    frames,
    listening,
    get conn() {
      return conn;
    },
    close() {
      conn?.destroy();
      server.close();
    },
  };
}

function spawnClient(socketPath: string, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [CLIENT_PATH, socketPath], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const out: Buffer[] = [];
  child.stdout.on('data', (c: Buffer) => out.push(c));
  let err = '';
  child.stderr.on('data', (c: Buffer) => {
    err += c.toString('utf8');
  });
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  return {
    child,
    // NUL heartbeat bytes survive utf8 decoding — countable in the stream.
    stdout: () => Buffer.concat(out).toString('utf8'),
    stderr: () => err,
    exited,
  };
}

describe('resolveHeartbeatMs', () => {
  it('defaults to 5s; junk, zero, and negative overrides are ignored', () => {
    expect(resolveHeartbeatMs({})).toBe(DEFAULT_HEARTBEAT_MS);
    expect(resolveHeartbeatMs({ NANOCLAW_ATTACH_HEARTBEAT_MS: 'soon' })).toBe(DEFAULT_HEARTBEAT_MS);
    expect(resolveHeartbeatMs({ NANOCLAW_ATTACH_HEARTBEAT_MS: '0' })).toBe(DEFAULT_HEARTBEAT_MS);
    expect(resolveHeartbeatMs({ NANOCLAW_ATTACH_HEARTBEAT_MS: '-5' })).toBe(DEFAULT_HEARTBEAT_MS);
    expect(resolveHeartbeatMs({ NANOCLAW_ATTACH_HEARTBEAT_MS: '250' })).toBe(250);
  });
});

describe('classifyAttachSocketError', () => {
  it('a post-connect error is a lost session (2), never "no socket here" (1)', () => {
    // The session killed while the operator is typing: the keystroke's write
    // surfaces EPIPE/ECONNRESET instead of a clean EOF — same lost session.
    expect(classifyAttachSocketError(true, 'EPIPE', true)).toBe(EXIT_SERVER_CLOSED);
    expect(classifyAttachSocketError(true, 'ECONNRESET', false)).toBe(EXIT_SERVER_CLOSED);
  });

  it('pre-connect missing/refused sockets retry inside the window, then exit 1', () => {
    expect(classifyAttachSocketError(false, 'ENOENT', true)).toBe('retry');
    expect(classifyAttachSocketError(false, 'ECONNREFUSED', true)).toBe('retry');
    expect(classifyAttachSocketError(false, 'ENOENT', false)).toBe(EXIT_NO_SOCKET);
    expect(classifyAttachSocketError(false, 'ECONNREFUSED', false)).toBe(EXIT_NO_SOCKET);
  });

  it('a pre-connect non-retryable failure exits 1 without burning the window', () => {
    expect(classifyAttachSocketError(false, 'EACCES', true)).toBe(EXIT_NO_SOCKET);
    expect(classifyAttachSocketError(false, undefined, true)).toBe(EXIT_NO_SOCKET);
  });
});

describe('attach client subprocess', () => {
  let server: ReturnType<typeof fakeServer> | null = null;
  afterEach(() => {
    server?.close();
    server = null;
  });

  it(
    'buffers stdin typed before the socket exists and replays it on connect (D13)',
    async () => {
      const socketPath = tmpSocketPath();
      // Client first — no socket yet, it must retry, not drop the keystrokes.
      const client = spawnClient(socketPath);
      client.child.stdin.write('hello');
      await sleep(150);
      server = fakeServer(socketPath);
      await server.listening;
      await waitFor(() => server!.frames.length > 0, 'the buffered frame');
      expect(server.frames[0]).toEqual({ type: FRAME_DATA, data: Buffer.from('hello') });
      expect(client.stdout()).toContain('[waiting for the session to come up…]');

      client.child.stdin.end(); // scripted pipe closed → clean detach
      expect(await client.exited).toBe(EXIT_DETACH);
      expect(server.frames.at(-1)).toEqual({ type: FRAME_DETACH });
    },
    10_000,
  );

  it(
    'Ctrl-] detaches with exit 0: bytes before the key reach the session, the key stays local',
    async () => {
      const socketPath = tmpSocketPath();
      server = fakeServer(socketPath);
      await server.listening;
      const client = spawnClient(socketPath);
      await waitFor(() => client.stdout().includes('[attached'), 'the attach banner');

      client.child.stdin.write(Buffer.concat([Buffer.from('ab'), Buffer.from([DETACH_KEY])]));
      expect(await client.exited).toBe(EXIT_DETACH);
      expect(client.stdout()).toContain('[detached — session keeps running]');
      expect(server.frames).toEqual([
        { type: FRAME_DATA, data: Buffer.from('ab') },
        { type: FRAME_DETACH },
      ]);
    },
    10_000,
  );

  it(
    'a paste containing 0x1d rides through intact; Ctrl-] after the paste still detaches',
    async () => {
      const socketPath = tmpSocketPath();
      server = fakeServer(socketPath);
      await server.listening;
      const client = spawnClient(socketPath);
      await waitFor(() => client.stdout().includes('[attached'), 'the attach banner');

      const paste = Buffer.from('\x1b[200~ab\x1dcd\x1b[201~', 'latin1');
      client.child.stdin.write(paste.subarray(0, 3)); // split mid-marker
      await sleep(50);
      client.child.stdin.write(paste.subarray(3));
      const dataBytes = () =>
        Buffer.concat(server!.frames.flatMap((f) => (f.type === FRAME_DATA ? [f.data] : [])));
      await waitFor(() => dataBytes().includes(paste), 'the intact paste at the server');

      // Outside the paste the key is still the detach key.
      client.child.stdin.write(Buffer.from([DETACH_KEY]));
      expect(await client.exited).toBe(EXIT_DETACH);
      expect(server.frames.at(-1)).toEqual({ type: FRAME_DETACH });
    },
    10_000,
  );

  it(
    'a server-side close is reported as a close, not a detach — exit 2',
    async () => {
      const socketPath = tmpSocketPath();
      server = fakeServer(socketPath);
      await server.listening;
      const client = spawnClient(socketPath);
      await waitFor(() => server!.conn !== null, 'the server-side socket');
      // Wait until the CLIENT knows it is attached: the parent sees the accept
      // a scheduling gap before the child processes its own connect, and a
      // close inside that gap reads as pre-connect — the retry window (15s)
      // then outlives the test timeout. Same discipline as the Ctrl-] case.
      await waitFor(() => client.stdout().includes('[attached'), 'the attach banner');

      server.conn!.end(); // session stopped/restarted from the other side
      expect(await client.exited).toBe(EXIT_SERVER_CLOSED);
      expect(client.stdout()).toContain('connection closed by the session');
    },
    10_000,
  );

  it(
    'a session killed while the operator types exits 2 — a lost session, never "no socket" (1)',
    async () => {
      const socketPath = tmpSocketPath();
      server = fakeServer(socketPath);
      await server.listening;
      const client = spawnClient(socketPath);
      await waitFor(() => client.stdout().includes('[attached'), 'the attach banner');

      // Hard-kill the server side, then land a keystroke on the corpse. The
      // client sees either the clean EOF or the write's EPIPE first (they
      // race on a real socket — the pure classifier pins the EPIPE branch);
      // BOTH must report the lost session as exit 2.
      server.conn!.destroy();
      client.child.stdin.write('x');
      expect(await client.exited).toBe(EXIT_SERVER_CLOSED);
    },
    10_000,
  );

  it(
    'a dead exec transport is a handled EPIPE with an honest notice — exit 3, not a crash',
    async () => {
      const socketPath = tmpSocketPath();
      server = fakeServer(socketPath);
      await server.listening;
      const client = spawnClient(socketPath, { NANOCLAW_ATTACH_HEARTBEAT_MS: '40' });
      await waitFor(() => client.stdout().includes('[attached'), 'the attach banner');

      // kubectl/ssh gone: the read side of the client's stdout pipe closes.
      // The next heartbeat write must surface it as EPIPE — the beat is the
      // prober that turns a silent corpse into a prompt exit.
      client.child.stdout.destroy();
      expect(await client.exited).toBe(EXIT_TRANSPORT_ERROR);
      expect(client.stderr()).toContain('connection lost (transport error:');
    },
    10_000,
  );

  it(
    'the beat is NULs on stdout and FRAME_PINGs on the socket — never anything input-shaped',
    async () => {
      const socketPath = tmpSocketPath();
      server = fakeServer(socketPath);
      await server.listening;
      const client = spawnClient(socketPath, { NANOCLAW_ATTACH_HEARTBEAT_MS: '25' });
      await waitFor(() => client.stdout().includes('[attached'), 'the attach banner');

      await waitFor(() => (client.stdout().match(/\x00/g) ?? []).length >= 2, 'two heartbeat NULs');
      await waitFor(() => server!.frames.length >= 2, 'two keepalive pings');
      // The liveness pin (D14): nothing input-shaped reached the attach
      // server — only pings, which the server refuses to count as evidence
      // (attach-server.ts), so the beat cannot stamp lastClientInputAt and
      // revive cycle-1's orphan immortality.
      expect(server.frames.every((f) => f.type === FRAME_PING)).toBe(true);

      client.child.stdin.end();
      expect(await client.exited).toBe(EXIT_DETACH);
    },
    10_000,
  );
});
