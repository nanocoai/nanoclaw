/**
 * Code-runner core: the attach protocol, the persistent PTY session's
 * respawn/replay behavior, and the attach server over a real unix socket.
 *
 * Unit tests drive the session with an injected fake PTY; one integration
 * case runs the real thing (Bun.Terminal, bun ≥ 1.3.5) and asserts the
 * full chain — output, INPUT (a child reading stdin must not see EOF),
 * and exit.
 */
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { describe, it, expect, afterEach, beforeEach } from 'bun:test';

import { loadConfig } from '../config.js';
import { registerAgentMailbox, resetAgentMailboxForTesting } from '../mailbox/index.js';
import { SqliteAgentMailbox } from '../mailbox/sqlite/index.js';
import { closeSessionDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import type { AgentMailboxFactory } from '../mailbox/types.js';
import { AttachServer } from './attach-server.js';
import { MailboxDeliveryLoop } from './mailbox.js';
import {
  DETACH_KEY,
  DetachKeyScanner,
  FRAME_DATA,
  FRAME_DETACH,
  FRAME_PING,
  FRAME_RESIZE,
  FrameParser,
  encodeData,
  encodeDetach,
  encodePing,
  encodeResize,
  splitAtDetachKey,
} from './protocol.js';
import { PtySession, type PtyLike, type SpawnPty } from './pty-session.js';

// ---------------------------------------------------------------------------
// Fake PTY

class FakePty implements PtyLike {
  pid = 4242;
  written = '';
  cols = 0;
  rows = 0;
  killed = false;
  private dataCbs: Array<(d: string) => void> = [];
  private exitCbs: Array<(e: { exitCode: number }) => void> = [];

  onData(cb: (d: string) => void) {
    this.dataCbs.push(cb);
    return { dispose: () => {} };
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCbs.push(cb);
    return { dispose: () => {} };
  }
  write(data: string) {
    this.written += data;
  }
  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }
  kill() {
    this.killed = true;
  }

  emitData(d: string) {
    for (const cb of this.dataCbs) cb(d);
  }
  emitExit(exitCode: number) {
    for (const cb of this.exitCbs) cb({ exitCode });
  }
}

function fakeSpawner(): { spawn: SpawnPty; ptys: FakePty[] } {
  const ptys: FakePty[] = [];
  const spawn: SpawnPty = (_file, _args, opts) => {
    const pty = new FakePty();
    // Capture the spawn geometry so tests can assert PtySession passes the
    // REMEMBERED cols/rows to a respawn, not the defaults.
    pty.cols = opts.cols;
    pty.rows = opts.rows;
    ptys.push(pty);
    return pty;
  };
  return { spawn, ptys };
}

function session(spawn: SpawnPty, extra: Partial<ConstructorParameters<typeof PtySession>[0]> = {}) {
  return new PtySession({
    command: 'fake',
    args: [],
    cwd: '/',
    env: {},
    spawnPty: spawn,
    restartDelayMs: 5,
    maxRestartDelayMs: 20,
    ...extra,
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Protocol

describe('attach protocol', () => {
  it('round-trips data, resize, detach, and ping through the incremental parser', () => {
    const parser = new FrameParser();
    const stream = Buffer.concat([encodeData('hello'), encodeResize(191, 47), encodePing(), encodeDetach()]);
    // Push byte by byte — frame boundaries never align with chunk boundaries.
    const frames = [];
    for (let i = 0; i < stream.length; i++) frames.push(...parser.push(stream.subarray(i, i + 1)));
    expect(frames).toHaveLength(4);
    expect(frames[0]).toEqual({ type: FRAME_DATA, data: Buffer.from('hello') });
    expect(frames[1]).toEqual({ type: FRAME_RESIZE, resize: { cols: 191, rows: 47 } });
    expect(frames[2]).toEqual({ type: FRAME_PING });
    expect(frames[3]).toEqual({ type: FRAME_DETACH });
  });

  it('rejects unknown frame types and absurd lengths', () => {
    expect(() => new FrameParser().push(Buffer.from([0x7f, 0, 0, 0, 0]))).toThrow(/unknown frame type/);
    const huge = Buffer.alloc(5);
    huge.writeUInt8(FRAME_DATA, 0);
    huge.writeUInt32BE(64 * 1024 * 1024, 1);
    expect(() => new FrameParser().push(huge)).toThrow(/exceeds/);
  });

  it('rejects a resize that is not positive integers', () => {
    const bad = (json: string) => {
      const payload = Buffer.from(json);
      const frame = Buffer.alloc(5 + payload.length);
      frame.writeUInt8(FRAME_RESIZE, 0);
      frame.writeUInt32BE(payload.length, 1);
      payload.copy(frame, 5);
      return frame;
    };
    expect(() => new FrameParser().push(bad('{"cols":0,"rows":10}'))).toThrow(/bad resize/);
    expect(() => new FrameParser().push(bad('not json'))).toThrow(/not JSON/);
  });

  it('splits keystrokes at the detach key, keeping what was typed before it', () => {
    expect(splitAtDetachKey(Buffer.from('abc'))).toEqual({ data: Buffer.from('abc'), detach: false });
    const withKey = Buffer.concat([Buffer.from('ab'), Buffer.from([DETACH_KEY]), Buffer.from('cd')]);
    expect(splitAtDetachKey(withKey)).toEqual({ data: Buffer.from('ab'), detach: true });
  });
});

describe('DetachKeyScanner (paste-aware detach)', () => {
  const START = Buffer.from('\x1b[200~', 'latin1');
  const END = Buffer.from('\x1b[201~', 'latin1');

  it('matches splitAtDetachKey semantics outside a paste', () => {
    const s = new DetachKeyScanner();
    expect(s.scan(Buffer.from('abc'))).toEqual({ data: Buffer.from('abc'), detach: false });
    const withKey = Buffer.concat([Buffer.from('ab'), Buffer.from([DETACH_KEY]), Buffer.from('cd')]);
    expect(s.scan(withKey)).toEqual({ data: Buffer.from('ab'), detach: true });
  });

  it('0x1d inside a bracketed paste is data; once the paste closes it detaches again', () => {
    const s = new DetachKeyScanner();
    const paste = Buffer.concat([START, Buffer.from('ab'), Buffer.from([DETACH_KEY]), Buffer.from('cd'), END]);
    expect(s.scan(paste)).toEqual({ data: paste, detach: false });
    expect(s.scan(Buffer.from([DETACH_KEY]))).toEqual({ data: Buffer.alloc(0), detach: true });
  });

  it('a 0x1d after the end marker IN THE SAME CHUNK detaches, paste intact', () => {
    const s = new DetachKeyScanner();
    const chunk = Buffer.concat([START, Buffer.from('x'), END, Buffer.from([DETACH_KEY]), Buffer.from('after')]);
    const expected = Buffer.concat([START, Buffer.from('x'), END]);
    expect(s.scan(chunk)).toEqual({ data: expected, detach: true });
  });

  it('tracks markers split at EVERY chunk boundary — nothing eaten, nothing detached', () => {
    const payload = Buffer.concat([START, Buffer.from('x'), Buffer.from([DETACH_KEY]), Buffer.from('y'), END]);
    for (let cut = 1; cut < payload.length; cut++) {
      const s = new DetachKeyScanner();
      const first = s.scan(payload.subarray(0, cut));
      const second = s.scan(payload.subarray(cut));
      expect(first.detach || second.detach).toBe(false);
      expect(Buffer.concat([first.data, second.data])).toEqual(payload);
    }
  });

  it('a broken marker prefix does not shield the detach key', () => {
    // ESC[20 then Ctrl-]: no paste opened — the operator gets their detach.
    const s = new DetachKeyScanner();
    const chunk = Buffer.concat([Buffer.from('\x1b[20', 'latin1'), Buffer.from([DETACH_KEY])]);
    expect(s.scan(chunk)).toEqual({ data: Buffer.from('\x1b[20', 'latin1'), detach: true });
  });

  it('a doubled ESC restarts marker matching — ESC ESC[200~ still opens the paste', () => {
    const s = new DetachKeyScanner();
    const chunk = Buffer.concat([Buffer.from([0x1b]), START, Buffer.from([DETACH_KEY])]);
    expect(s.scan(chunk)).toEqual({ data: chunk, detach: false });
  });

  it('a stray end marker without a paste leaves detach armed', () => {
    const s = new DetachKeyScanner();
    const chunk = Buffer.concat([END, Buffer.from([DETACH_KEY])]);
    expect(s.scan(chunk)).toEqual({ data: END, detach: true });
  });
});

// ---------------------------------------------------------------------------
// PtySession

describe('PtySession', () => {
  it('respawns a dead process and tells subscribers, then stops respawning once disposed', async () => {
    const { spawn, ptys } = fakeSpawner();
    const s = session(spawn);
    const seen: string[] = [];
    s.subscribe((c) => seen.push(c.toString('utf8')));
    s.start();
    expect(ptys).toHaveLength(1);

    ptys[0].emitData('first life');
    ptys[0].emitExit(1);
    expect(s.running).toBe(false);
    await sleep(15);
    expect(ptys).toHaveLength(2);
    expect(s.running).toBe(true);
    expect(seen.join('')).toContain('first life');
    expect(seen.join('')).toContain('exited (code 1)');

    s.dispose();
    ptys[1].emitExit(0);
    await sleep(30);
    expect(ptys).toHaveLength(2); // no third life after dispose
    expect(ptys[1].killed).toBe(true);
  });

  it('replays recent output to a fresh subscriber via the ring buffer, trimming at the cap', () => {
    const { spawn, ptys } = fakeSpawner();
    const s = session(spawn, { replayBytes: 8 });
    s.start();
    ptys[0].emitData('aaaa');
    ptys[0].emitData('bbbb');
    ptys[0].emitData('cccc');
    // 12 bytes emitted, cap 8 — the oldest chunk fell off.
    expect(s.replay().toString('utf8')).toBe('bbbbcccc');
  });

  it('applies the last resize to a respawned process', async () => {
    const { spawn, ptys } = fakeSpawner();
    const s = session(spawn);
    s.start();
    s.resize(200, 50);
    expect(ptys[0].cols).toBe(200);
    ptys[0].emitExit(0);
    await sleep(15);
    // The new process was spawned with the remembered geometry, not defaults.
    expect(ptys[1].cols).toBe(200);
    expect(ptys[1].rows).toBe(50);
    s.dispose();
  });

  it('C13 fallback: a first life dead before healthyRunMs respawns with fallbackArgs, one-way', async () => {
    const argsSeen: string[][] = [];
    const { spawn, ptys } = fakeSpawner();
    const capturing: SpawnPty = (file, args, opts) => {
      argsSeen.push(args);
      return spawn(file, args, opts);
    };
    let clock = 0;
    const s = session(capturing, {
      args: ['--continue'],
      fallbackArgs: [],
      healthyRunMs: 10_000,
      now: () => clock,
    });
    s.start();
    clock = 50; // died 50ms in — the resume never took
    ptys[0].emitExit(1);
    await sleep(15);
    expect(argsSeen).toEqual([['--continue'], []]);

    // The swap is one-way: a later (healthy) life dying keeps the fresh args.
    clock = 20_000;
    ptys[1].emitExit(0);
    await sleep(15);
    expect(argsSeen[2]).toEqual([]);
    s.dispose();
  });

  it('C13 fallback: a healthy first life keeps its argv for good', async () => {
    const argsSeen: string[][] = [];
    const { spawn, ptys } = fakeSpawner();
    const capturing: SpawnPty = (file, args, opts) => {
      argsSeen.push(args);
      return spawn(file, args, opts);
    };
    let clock = 0;
    const s = session(capturing, {
      args: ['--continue'],
      fallbackArgs: [],
      healthyRunMs: 10_000,
      now: () => clock,
    });
    s.start();
    clock = 20_000; // the resume took — this life ran well past the window
    ptys[0].emitExit(0);
    await sleep(15);
    expect(argsSeen).toEqual([['--continue'], ['--continue']]);
    s.dispose();
  });

  it('fires onSpawn for every child life and advances lastSpawnAt', async () => {
    const { spawn, ptys } = fakeSpawner();
    const spawns: number[] = [];
    let clock = 100;
    const s = new PtySession({
      command: 'fake',
      args: [],
      cwd: '/',
      env: {},
      spawnPty: spawn,
      restartDelayMs: 5,
      maxRestartDelayMs: 10,
      now: () => clock,
      onSpawn: (at) => spawns.push(at),
    });
    s.start();
    expect(spawns).toEqual([100]);
    expect(s.lastSpawnAt).toBe(100);
    clock = 200;
    ptys[0].emitExit(1);
    await sleep(15);
    expect(spawns).toEqual([100, 200]); // respawn = a fresh life, same signal
    expect(s.lastSpawnAt).toBe(200);
    s.dispose();
  });

  it('routes writes to the live process only', () => {
    const { spawn, ptys } = fakeSpawner();
    const s = session(spawn);
    s.start();
    s.write('typed');
    expect(ptys[0].written).toBe('typed');
    s.dispose();
  });
});

// ---------------------------------------------------------------------------
// AttachServer over a real unix socket

function tmpSocketPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-attach-')), 'attach.sock');
}

function connect(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

function collect(socket: net.Socket): () => string {
  let buf = '';
  socket.on('data', (c) => {
    buf += c.toString('utf8');
  });
  return () => buf;
}

describe('AttachServer', () => {
  let server: AttachServer | null = null;
  afterEach(() => {
    server?.close();
    server = null;
  });

  it('replays history on connect, streams live output, and forwards typed frames', async () => {
    const { spawn, ptys } = fakeSpawner();
    const s = session(spawn);
    s.start();
    ptys[0].emitData('before-attach ');
    server = new AttachServer(s, tmpSocketPath());
    await server.listen();

    const client = await connect(server['socketPath'] as string);
    const output = collect(client);
    await sleep(10);
    expect(output()).toBe('before-attach ');

    ptys[0].emitData('live');
    client.write(Buffer.concat([encodeData('typed input'), encodeResize(99, 33)]));
    await sleep(10);
    expect(output()).toBe('before-attach live');
    expect(ptys[0].written).toBe('typed input');
    expect(ptys[0].cols).toBe(99);
    expect(ptys[0].rows).toBe(33);
    client.destroy();
  });

  it('both clients see the stream; detach closes only the detaching client', async () => {
    const { spawn, ptys } = fakeSpawner();
    const s = session(spawn);
    s.start();
    server = new AttachServer(s, tmpSocketPath());
    await server.listen();

    const a = await connect(server['socketPath'] as string);
    const b = await connect(server['socketPath'] as string);
    const outA = collect(a);
    const outB = collect(b);
    await sleep(10);
    expect(server.clientCount).toBe(2);

    ptys[0].emitData('broadcast');
    a.write(encodeDetach());
    await sleep(15);
    expect(outA()).toBe('broadcast');
    expect(outB()).toBe('broadcast');
    expect(server.clientCount).toBe(1);

    // The session did not notice the detach.
    expect(s.running).toBe(true);
    b.destroy();
  });

  it('reports every client-count change exactly once (the attach-presence stamp)', async () => {
    const { spawn } = fakeSpawner();
    const s = session(spawn);
    s.start();
    const counts: number[] = [];
    server = new AttachServer(s, tmpSocketPath(), (count) => counts.push(count));
    await server.listen();

    const a = await connect(server['socketPath'] as string);
    const b = await connect(server['socketPath'] as string);
    await sleep(10);
    expect(counts).toEqual([1, 2]);

    // destroy() fires both 'close' and 'error' paths; the count must drop once.
    a.destroy();
    await sleep(15);
    expect(counts).toEqual([1, 2, 1]);

    server.close();
    await sleep(10);
    expect(counts[counts.length - 1]).toBe(0);
    b.destroy();
  });

  it('drops a client that sends garbage, keeping the session alive', async () => {
    const { spawn } = fakeSpawner();
    const s = session(spawn);
    s.start();
    server = new AttachServer(s, tmpSocketPath());
    await server.listen();

    const client = await connect(server['socketPath'] as string);
    const closed = new Promise<void>((r) => client.once('close', () => r()));
    client.write(Buffer.from([0x7f, 0, 0, 0, 0]));
    await closed;
    expect(server.clientCount).toBe(0);
    expect(s.running).toBe(true);
  });

  it('a fan-out write to a destroyed socket cleans up without crashing; other clients unaffected', async () => {
    const { spawn, ptys } = fakeSpawner();
    const s = session(spawn);
    s.start();
    server = new AttachServer(s, tmpSocketPath());
    await server.listen();

    const dead = await connect(server['socketPath'] as string);
    const live = await connect(server['socketPath'] as string);
    const outLive = collect(live);
    await sleep(10);
    expect(server.clientCount).toBe(2);

    // Kill the SERVER side of the first connection, then emit in the same
    // tick — before its 'close' dispatches and unsubscribes, so the fan-out
    // write lands on an already-destroyed socket (the exact shape a dead
    // exec transport leaves behind).
    const serverSockets = [...(server['clients'] as Set<net.Socket>)];
    serverSockets[0].destroy();
    ptys[0].emitData('after-death');
    await sleep(20);

    expect(server.clientCount).toBe(1); // the corpse was cleaned up
    expect(outLive()).toBe('after-death'); // the live client saw everything
    expect(s.running).toBe(true);

    // The survivor can still type into the session.
    live.write(encodeData('still-typing'));
    await sleep(10);
    expect(ptys[0].written).toBe('still-typing');
    live.destroy();
    dead.destroy();
  });

  it('sweeps a silent client past the keepalive deadline; a pinging client survives', async () => {
    const { spawn } = fakeSpawner();
    const s = session(spawn);
    s.start();
    server = new AttachServer(s, tmpSocketPath(), undefined, {
      keepaliveDeadlineMs: 200,
      sweepIntervalMs: 40,
    });
    await server.listen();

    // The orphan shape: a client-shaped socket that never speaks again —
    // socket close never comes (the exec shim holds it), so only the sweep
    // can retire it.
    const silent = await connect(server['socketPath'] as string);
    const pinger = await connect(server['socketPath'] as string);
    const pingTimer = setInterval(() => pinger.write(encodePing()), 50);
    await sleep(10);
    expect(server.clientCount).toBe(2);

    await new Promise<void>((r) => silent.once('close', () => r()));
    expect(server.clientCount).toBe(1);
    // The pinger has outlived several deadlines by now and stays.
    await sleep(300);
    expect(server.clientCount).toBe(1);
    clearInterval(pingTimer);
    pinger.destroy();
  });

  it('pings are keepalive only — they never stamp the human-evidence clocks or reach the PTY', async () => {
    const { spawn, ptys } = fakeSpawner();
    const s = session(spawn);
    s.start();
    server = new AttachServer(s, tmpSocketPath());
    await server.listen();

    const client = await connect(server['socketPath'] as string);
    await sleep(10);
    const connectAt = server.lastClientConnectAt;
    client.write(encodePing());
    await sleep(20);
    // The D14/D17 pin: machine chatter is not human presence. A ping that
    // stamped these would resurrect cycle-1's orphan-exec immortality.
    expect(server.lastClientInputAt).toBe(0);
    expect(server.lastClientConnectAt).toBe(connectAt);
    expect(ptys[0].written).toBe('');

    // A real keystroke still stamps input evidence.
    client.write(encodeData('x'));
    await sleep(20);
    expect(server.lastClientInputAt).toBeGreaterThan(0);
    expect(ptys[0].written).toBe('x');
    client.destroy();
  });

  it('a wedged client past the buffer cap is destroyed on the clean path; the flowing client drains fully', async () => {
    const { spawn, ptys } = fakeSpawner();
    const s = session(spawn, { replayBytes: 1024 });
    s.start();
    server = new AttachServer(s, tmpSocketPath());
    await server.listen();

    const wedged = await connect(server['socketPath'] as string);
    wedged.pause(); // stops reading — the server's write buffer balloons
    const flowing = await connect(server['socketPath'] as string);
    let flowingBytes = 0;
    flowing.on('data', (c) => {
      flowingBytes += c.length;
    });
    await sleep(10);
    expect(server.clientCount).toBe(2);

    // 8 MiB into a client that reads nothing: past MAX_BUFFERED_BYTES the
    // server must drop it rather than balloon the runner. Emitted in paced
    // chunks so the FLOWING client drains between writes — only the wedge
    // may accumulate past the cap.
    const chunk = 'x'.repeat(512 * 1024);
    for (let i = 0; i < 16; i++) {
      ptys[0].emitData(chunk);
      await sleep(5);
    }
    await sleep(50);

    expect(server.clientCount).toBe(1);
    expect(s.running).toBe(true);
    // The flowing client still receives the full stream.
    const deadline = Date.now() + 3_000;
    while (flowingBytes < 8 * 1024 * 1024 && Date.now() < deadline) await sleep(10);
    expect(flowingBytes).toBe(8 * 1024 * 1024);
    flowing.destroy();
    wedged.destroy();
  });
});

// ---------------------------------------------------------------------------
// The mailbox loop and the attach server sharing ONE PtySession — the shape
// production wires in index.ts. The pin: an injection fans out to whoever is
// attached, and a client whose transport died mid-attach never disturbs the
// injection, the PTY, or the other halves of the runner.

describe('mailbox injection fan-out (MailboxDeliveryLoop + AttachServer on one PtySession)', () => {
  loadConfig(); // defaults — getPendingMessages reads maxMessagesPerPrompt

  let inbound: ReturnType<typeof initTestSessionDb>['inbound'];
  let statePath: string;
  let server: AttachServer | null = null;
  let composed: AgentMailboxFactory | undefined;

  beforeEach(() => {
    inbound = initTestSessionDb().inbound;
    statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-fanout-')), 'state.json');
    // The fan-out is a PTY/socket claim, not a transport one: it seeds and
    // reads the session DB directly, so the delivery loop must resolve to
    // SQLite whatever the recipe composed. See mailbox.test.ts's header.
    composed = resetAgentMailboxForTesting();
    registerAgentMailbox(() => new SqliteAgentMailbox());
  });

  afterEach(() => {
    server?.close();
    server = null;
    closeSessionDb();
    resetAgentMailboxForTesting();
    if (composed) registerAgentMailbox(composed);
  });

  function seedInbound(id: string, text: string): void {
    inbound
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, on_wake, content)
         VALUES (?, 'chat', ?, 'pending', 1, 0, ?)`,
      )
      .run(id, new Date().toISOString(), JSON.stringify({ text, sender: 'gavriel' }));
  }

  it('injects into the PTY, fans the echo out to the client, and shrugs off a dead client socket', async () => {
    const { spawn, ptys } = fakeSpawner();
    const s = session(spawn);
    s.start();
    server = new AttachServer(s, tmpSocketPath());
    await server.listen();
    const loop = new MailboxDeliveryLoop({
      session: s,
      stateFilePath: statePath,
      lastOperatorInputAt: () => server!.lastClientInputAt,
      onFatal: () => {},
    });

    // Readiness is per child life: the idle stamp must postdate THIS
    // session's spawn and the loop's boot, or delivery holds (by design).
    fs.writeFileSync(statePath, JSON.stringify({ state: 'idle', at: new Date().toISOString() }));

    const client = await connect(server['socketPath'] as string);
    const out = collect(client);
    await sleep(10);

    seedInbound('m1', 'mail one');
    await loop.tick();
    expect(ptys[0].written).toContain('mail one'); // typed into the PTY
    ptys[0].emitData(ptys[0].written); // the PTY echoes what was typed
    await sleep(10);
    expect(out()).toContain('mail one'); // …and the attached human saw it

    // Ack-on-transition: m1 is pending-ack until a hook stamp STRICTLY newer
    // than the injection proves the TUI took the input — without it, m1's
    // claim blocks m2 (by design, not by accident). The sleep(10) above
    // already put us past the injection's millisecond; stamp a fresh idle
    // (a Stop from the turn m1 started) so the next tick acks m1 and reads
    // ready for m2.
    fs.writeFileSync(statePath, JSON.stringify({ state: 'idle', at: new Date().toISOString() }));

    // The client's transport dies without a clean close reaching us yet.
    const serverSide = [...(server['clients'] as Set<net.Socket>)][0];
    serverSide.destroy();
    seedInbound('m2', 'mail two');
    await loop.tick();
    expect(ptys[0].written).toContain('mail two'); // injection undisturbed
    ptys[0].emitData('echo-into-the-void');
    await sleep(20);

    expect(server.clientCount).toBe(0); // corpse cleaned up
    expect(s.running).toBe(true); // the PTY never noticed
    client.destroy();
  });
});

// ---------------------------------------------------------------------------
// The one real-PTY case: PtySession over Bun.Terminal, end to end. The input
// assertion is the load-bearing one — a PTY whose child EOFs on stdin read
// is useless for an interactive agent (node-pty under bun failed exactly
// there, which is why this stays as a tripwire).

describe('real PTY integration (Bun.Terminal)', () => {
  it('resize notifies the child — SIGWINCH is delivered even with no controlling terminal', async () => {
    // The trap's `stty size` reads the pty via stdin: kernel-truth evidence
    // that the child both HEARD the resize and sees the new winsize.
    const s = new PtySession({
      command: 'sh',
      args: ['-c', 'trap "stty size" WINCH; echo winch-ready; while :; do sleep 0.1; done'],
      cwd: '/',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    const seen: string[] = [];
    s.subscribe((c) => seen.push(c.toString('utf8')));
    s.start();
    try {
      const deadline = Date.now() + 8_000;
      while (!seen.join('').includes('winch-ready') && Date.now() < deadline) await sleep(50);
      expect(seen.join('')).toContain('winch-ready');
      s.resize(101, 31);
      while (!seen.join('').includes('31 101') && Date.now() < deadline) await sleep(50);
      expect(seen.join('')).toContain('31 101');
    } finally {
      s.dispose();
    }
  }, 15_000);

  it('output flows, input round-trips, exit is observed', async () => {
    const s = new PtySession({
      command: 'sh',
      args: ['-c', 'echo real-pty-live; exec cat'],
      cwd: '/',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    const seen: string[] = [];
    s.subscribe((c) => seen.push(c.toString('utf8')));
    s.start();
    await sleep(300);
    expect(seen.join('')).toContain('real-pty-live');
    expect(seen.join('')).not.toContain('exited'); // premature death = stdin EOF
    s.write('echoed-back\n');
    await sleep(300);
    expect(seen.join('')).toContain('echoed-back');
    s.dispose();
  });
});
