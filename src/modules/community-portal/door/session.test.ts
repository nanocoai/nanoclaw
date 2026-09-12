/**
 * One connection through the session handler with ssh2's objects faked:
 * the authentication decisions (public key only, any username, signatures
 * checked, unknown keys admitted), the session requests (PTY, resize,
 * shell, exec, refused forwarding and subsystems), the waiting room in
 * session, the session cap, revocation ending a live session, and the
 * terminal put back in order (with a word why) when the exec ends under the
 * client. The container runtime's exec stream is faked with a pair of streams.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import ssh2, { type ClientInfo, type Connection, type ParsedKey, type Session } from 'ssh2';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { SessionExecOptions, SessionExecStream } from '../../../drivers/types.js';
import { fingerprintOf } from './keys.js';
import type { AttachTarget } from './landing.js';
import { handleConnection, MAX_SESSIONS, type SessionDeps } from './session.js';
import { loadSsh2 } from './ssh2.js';
import type { DoorStream } from './target-map.js';
import { TERMINAL_RESET, terminalEnded } from './terminal-reset.js';

const { utils } = ssh2;

// The server loads the library before it accepts a connection; here the
// handler is driven directly, so load it first.
beforeAll(() => loadSsh2());

class FakeChannel extends EventEmitter {
  out = '';
  err = '';
  exitCode: number | undefined;
  ended = false;
  stderr = {
    write: (data: Buffer | string): boolean => {
      this.err += String(data);
      return true;
    },
  };
  write(data: Buffer | string): boolean {
    this.out += String(data);
    return true;
  }
  exit(code: number): void {
    this.exitCode = code;
  }
  end(): void {
    this.ended = true;
  }
}

class FakeClient extends EventEmitter {
  ended = false;
  end(): void {
    this.ended = true;
    this.emit('close');
  }
}

/** A fake runtime exec: what the command "prints" goes into `stdout`, what the session sends lands in `input`. */
class FakeExec implements SessionExecStream {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr?: PassThrough;
  input = '';
  resized: [number, number][] = [];
  closed = false;
  private finish!: (code: number) => void;
  private fail!: (error: Error) => void;
  exited = new Promise<number>((resolve, reject) => {
    this.finish = resolve;
    this.fail = reject;
  });
  constructor(tty: boolean) {
    if (!tty) this.stderr = new PassThrough();
    this.stdin.on('data', (data: Buffer) => (this.input += data.toString()));
  }
  resize = vi.fn(async (cols: number, rows: number) => {
    this.resized.push([cols, rows]);
  });
  close(): void {
    this.closed = true;
    this.finish(129);
  }
  exit(code: number): void {
    this.finish(code);
  }
  /** The stream broke: no exit code will ever be known. */
  break(): void {
    this.fail(new Error('stream broke'));
  }
}

const INFO: ClientInfo = { ip: '127.0.0.1', port: 50562, family: 'IPv4', header: {} as ClientInfo['header'] };

function keyPair(): { key: ParsedKey; blob: Buffer; fingerprint: string } {
  const pair = utils.generateKeyPairSync('ed25519');
  const parsed = utils.parseKey(pair.private);
  const key = (Array.isArray(parsed) ? parsed[0] : parsed) as ParsedKey;
  const blob = key.getPublicSSH();
  return { key, blob, fingerprint: fingerprintOf(blob) };
}

function authContext(method: string, username: string, key?: ReturnType<typeof keyPair>, sign = true) {
  const blob = Buffer.from('session-id-and-request');
  return {
    method,
    username,
    service: 'ssh-connection',
    key: key ? { algo: 'ssh-ed25519', data: key.blob } : undefined,
    signature: key && sign ? key.key.sign(blob) : undefined,
    blob: key && sign ? blob : undefined,
    hashAlgo: undefined,
    accept: vi.fn(),
    reject: vi.fn(),
  };
}

function deps(
  overrides: Partial<SessionDeps> & {
    approved?: string[];
    streams?: Record<number, DoorStream>;
    noStream?: boolean;
    /** The runtime's answer to whether the session still runs, once its exec ended. */
    alive?: () => Promise<boolean>;
  } = {},
) {
  const approved = new Set(overrides.approved ?? []);
  const ends = new Map<string, () => void>();
  const execs: { exec: FakeExec; command: string[]; options: SessionExecOptions }[] = [];
  const logs: { level: string; message: string; data?: Record<string, unknown> }[] = [];
  let live = 0;
  let waiters: ((approved: boolean) => void)[] = [];
  const targetFor = (name: string): AttachTarget => ({
    containerName: `ncl-${name}`,
    command: ['tmux', 'attach', name],
    ...(overrides.noStream
      ? {}
      : {
          execStream: async (command: string[], options: SessionExecOptions) => {
            const exec = new FakeExec(options.tty);
            execs.push({ exec, command, options });
            return exec;
          },
        }),
    ...(overrides.alive ? { alive: overrides.alive } : {}),
  });
  const d: SessionDeps = {
    authority: {
      status: (fp) => (approved.has(fp) ? 'approved' : 'unknown'),
      openRoom: vi.fn(async () => 'ok' as const),
      waitForApproval: vi.fn(
        (fp) =>
          new Promise<boolean>((resolve) => {
            if (approved.has(fp)) return resolve(true);
            waiters.push(resolve);
          }),
      ),
      registerSession: vi.fn((fp, end) => {
        ends.set(fp, end);
        return () => ends.delete(fp);
      }),
    },
    lookupTarget: (port) => overrides.streams?.[port],
    pending: vi.fn(async (request) => ({ url: request.approvalUrl, expiresAt: 'x', code: 'ABCD-EFGH' })),
    approvalUrl: () => 'https://example.test/terminals',
    sandboxes: {
      list: vi.fn(async () => ({ names: ['alice'], human: 'SANDBOX\nalice' })),
      attach: vi.fn(async (name: string) => targetFor(name)),
      create: vi.fn(async (name: string) => targetFor(name)),
    },
    sessions: {
      count: () => live,
      track: () => {
        live += 1;
        return () => {
          live -= 1;
        };
      },
    },
    log: (level, message, data) => logs.push({ level, message, data }),
    ...overrides,
  };
  return {
    deps: d,
    approve: (fp: string) => {
      approved.add(fp);
      const pending = waiters;
      waiters = [];
      for (const resolve of pending) resolve(true);
    },
    ends,
    execs,
    logs,
    live: () => live,
  };
}

/** Connect, authenticate with a signed public key, and open a session. */
function connect(d: SessionDeps, username = 'anyname', key = keyPair()) {
  const client = new FakeClient();
  handleConnection(client as unknown as Connection, INFO, d);
  const ctx = authContext('publickey', username, key);
  client.emit('authentication', ctx);
  client.emit('ready');
  const session = new EventEmitter();
  client.emit('session', () => session as unknown as Session, vi.fn());
  return { client, session, key, ctx };
}

function shell(session: EventEmitter, pty = true): FakeChannel {
  if (pty)
    session.emit('pty', vi.fn(), vi.fn(), {
      term: 'xterm-256color',
      cols: 120,
      rows: 40,
      width: 0,
      height: 0,
      modes: {},
    });
  const channel = new FakeChannel();
  session.emit('shell', () => channel, vi.fn());
  return channel;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('the pre-auth deadline', () => {
  it('ends a connection that has not authenticated in time, and leaves one that has alone', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const f = deps({ authDeadlineMs: 1_000 });
      const idle = new FakeClient();
      handleConnection(idle as unknown as Connection, INFO, f.deps);
      await vi.advanceTimersByTimeAsync(999);
      expect(idle.ended).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(idle.ended).toBe(true);
      expect(f.logs.at(-1)).toMatchObject({ message: expect.stringMatching(/not authenticated in time/) });

      const { client } = connect(f.deps);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(client.ended).toBe(false);
      // A client that left before the deadline is not touched again.
      const gone = new FakeClient();
      handleConnection(gone as unknown as Connection, INFO, f.deps);
      gone.end();
      const endedOnce = gone.ended;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(gone.ended).toBe(endedOnce);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('authentication', () => {
  it('offers public key only and ignores the username', () => {
    const f = deps();
    const client = new FakeClient();
    handleConnection(client as unknown as Connection, INFO, f.deps);
    for (const method of ['none', 'password', 'keyboard-interactive']) {
      const ctx = authContext(method, 'root');
      client.emit('authentication', ctx);
      expect(ctx.reject).toHaveBeenCalledWith(['publickey']);
      expect(ctx.accept).not.toHaveBeenCalled();
    }
    const key = keyPair();
    for (const username of ['alice', 'root', 'anything-at-all']) {
      const ctx = authContext('publickey', username, key);
      client.emit('authentication', ctx);
      expect(ctx.accept).toHaveBeenCalledTimes(1);
      expect(ctx.reject).not.toHaveBeenCalled();
    }
    client.emit('ready');
    expect(f.logs.at(-1)).toMatchObject({ message: 'Remote terminal login', data: { username: 'anything-at-all' } });
  });

  it('accepts the key query, rejects a bad signature, and rejects everything while disabled', () => {
    const client = new FakeClient();
    const d = deps().deps;
    handleConnection(client as unknown as Connection, INFO, d);
    const key = keyPair();
    const query = authContext('publickey', 'x', key, false);
    client.emit('authentication', query);
    expect(query.accept).toHaveBeenCalled();

    const forged = authContext('publickey', 'x', key);
    forged.signature = Buffer.alloc(64, 1);
    client.emit('authentication', forged);
    expect(forged.reject).toHaveBeenCalledWith(['publickey']);

    const disabled = deps({ authority: { ...d.authority, status: () => 'disabled' } }).deps;
    const off = new FakeClient();
    handleConnection(off as unknown as Connection, INFO, disabled);
    const ctx = authContext('publickey', 'x', key);
    off.emit('authentication', ctx);
    expect(ctx.reject).toHaveBeenCalledWith(['publickey']);
  });
});

describe('sessions', () => {
  it('lands an approved key in its stream’s sandbox on a sized TTY exec, resizes, pumps bytes, and exits with it', async () => {
    const key = keyPair();
    const f = deps({
      approved: [key.fingerprint],
      streams: { 50562: { target: { account: 'alice', sandbox: 'demo' }, openedAt: 't' } },
    });
    const { session, client } = connect(f.deps, 'whoever', key);
    const channel = shell(session);
    await vi.waitFor(() => expect(f.execs).toHaveLength(1));
    const { exec, command, options } = f.execs[0];
    expect(command).toEqual(['tmux', 'attach', 'demo']);
    expect(options).toEqual({ tty: true, cols: 120, rows: 40 });
    expect(channel.out).toContain('Attaching to sandbox demo — detach with Ctrl-b then d.\r\n');
    expect(f.live()).toBe(1);

    session.emit('window-change', vi.fn(), vi.fn(), { cols: 200, rows: 50, width: 0, height: 0 });
    await settle();
    expect(exec.resized).toEqual([[200, 50]]);
    channel.emit('data', Buffer.from('ls\r'));
    await settle();
    expect(exec.input).toBe('ls\r');
    exec.stdout.write('hello from tmux');
    await settle();
    expect(channel.out).toContain('hello from tmux');

    exec.exit(3);
    await vi.waitFor(() => expect(channel.exitCode).toBe(3));
    expect(channel.ended).toBe(true);
    // The program's last bytes, then the terminal put back, then the word why.
    expect(channel.out.endsWith(`hello from tmux${terminalEnded('exit code 3')}`)).toBe(true);
    expect(f.live()).toBe(0);
    expect(client.ended).toBe(false);
  });

  it('puts the terminal back and says the container stopped when the exec dies under the client', async () => {
    const key = keyPair();
    const f = deps({
      approved: [key.fingerprint],
      streams: { 50562: { target: { account: 'alice', sandbox: 'demo' }, openedAt: 't' } },
      alive: async () => false,
    });
    const { session } = connect(f.deps, 'x', key);
    const channel = shell(session);
    await vi.waitFor(() => expect(f.execs).toHaveLength(1));
    const { exec } = f.execs[0];
    exec.stdout.write('\x1b[?1000h\x1b[?2004hlast frame');
    await settle();
    exec.exit(137);
    await vi.waitFor(() => expect(channel.exitCode).toBe(137));
    expect(channel.ended).toBe(true);
    const reset = channel.out.indexOf(TERMINAL_RESET);
    const why = channel.out.indexOf('[nanoclaw] session ended: container stopped');
    expect(channel.out.indexOf('last frame')).toBeLessThan(reset);
    expect(reset).toBeGreaterThan(-1);
    expect(why).toBeGreaterThan(reset);
    expect(channel.out.endsWith(terminalEnded('container stopped'))).toBe(true);
    expect(channel.out.split(TERMINAL_RESET)).toHaveLength(2);
  });

  it('a clean detach puts the terminal back without a word, once', async () => {
    const key = keyPair();
    const f = deps({
      approved: [key.fingerprint],
      streams: { 50562: { target: { account: 'alice', sandbox: 'demo' }, openedAt: 't' } },
      alive: async () => false,
    });
    const { session } = connect(f.deps, 'x', key);
    const channel = shell(session);
    await vi.waitFor(() => expect(f.execs).toHaveLength(1));
    const { exec } = f.execs[0];
    exec.stdout.write('[detached (from session agent)]\r\n');
    await settle();
    exec.exit(0);
    await vi.waitFor(() => expect(channel.exitCode).toBe(0));
    expect(channel.ended).toBe(true);
    expect(channel.out.endsWith(`[detached (from session agent)]\r\n${TERMINAL_RESET}`)).toBe(true);
    expect(channel.out.split(TERMINAL_RESET)).toHaveLength(2);
    expect(channel.out).not.toContain('[nanoclaw] session ended');
  });

  it('reports the exit code when the runtime still runs or cannot say, and a broken stream as closed', async () => {
    const key = keyPair();
    const stream: DoorStream = { target: { account: 'alice', sandbox: 'demo' }, openedAt: 't' };
    const running = deps({ approved: [key.fingerprint], streams: { 50562: stream }, alive: async () => true });
    const { session } = connect(running.deps, 'x', key);
    const channel = shell(session);
    await vi.waitFor(() => expect(running.execs).toHaveLength(1));
    running.execs[0].exec.exit(130);
    await vi.waitFor(() => expect(channel.exitCode).toBe(130));
    expect(channel.out.endsWith(terminalEnded('exit code 130'))).toBe(true);

    const unsure = deps({
      approved: [key.fingerprint],
      streams: { 50562: stream },
      alive: async () => {
        throw new Error('no daemon');
      },
    });
    const { session: second } = connect(unsure.deps, 'x', key);
    const other = shell(second);
    await vi.waitFor(() => expect(unsure.execs).toHaveLength(1));
    unsure.execs[0].exec.exit(137);
    await vi.waitFor(() => expect(other.exitCode).toBe(137));
    expect(other.out.endsWith(terminalEnded('exit code 137'))).toBe(true);

    const broken = deps({ approved: [key.fingerprint], streams: { 50562: stream }, alive: async () => false });
    const { session: third } = connect(broken.deps, 'x', key);
    const last = shell(third);
    await vi.waitFor(() => expect(broken.execs).toHaveLength(1));
    broken.execs[0].exec.break();
    await vi.waitFor(() => expect(last.exitCode).toBe(1));
    expect(last.out.endsWith(terminalEnded('stream closed'))).toBe(true);
    expect(last.ended).toBe(true);
  });

  it('runs `ls` as an exec without a TTY and refuses other commands', async () => {
    const key = keyPair();
    const f = deps({
      approved: [key.fingerprint],
      streams: { 50562: { target: { account: 'alice' }, openedAt: 't' } },
    });
    const { session } = connect(f.deps, 'x', key);
    const channel = new FakeChannel();
    session.emit('exec', () => channel, vi.fn(), { command: 'ls' });
    await vi.waitFor(() => expect(channel.exitCode).toBe(0));
    expect(channel.out).toBe('SANDBOX\nalice\n');
    expect(f.execs).toHaveLength(0);

    const { session: again } = connect(f.deps, 'x', key);
    const other = new FakeChannel();
    again.emit('exec', () => other, vi.fn(), { command: 'bash' });
    await vi.waitFor(() => expect(other.exitCode).toBe(2));
    expect(other.err).toMatch(/usage/);
  });

  it('attaches without a TTY as a plain exec, keeping stderr apart and passing EOF through', async () => {
    const key = keyPair();
    const f = deps({
      approved: [key.fingerprint],
      streams: { 50562: { target: { account: 'alice' }, openedAt: 't' } },
    });
    const { session } = connect(f.deps, 'x', key);
    const channel = shell(session, false);
    await vi.waitFor(() => expect(f.execs).toHaveLength(1));
    const { exec, options } = f.execs[0];
    expect(options).toEqual({ tty: false });
    expect(channel.out).toContain('Attaching to sandbox alice — detach with Ctrl-b then d.\n');
    exec.stderr!.write('warning');
    await settle();
    expect(channel.err).toContain('warning');
    const ended = new Promise<void>((resolve) => exec.stdin.on('end', () => resolve()));
    channel.emit('eof');
    await ended;
    exec.exit(0);
    await vi.waitFor(() => expect(channel.exitCode).toBe(0));
    // No terminal, nothing to put back.
    expect(channel.out).not.toContain(TERMINAL_RESET);
    expect(channel.out).not.toContain('[nanoclaw] session ended');
  });

  it('holds an unknown key in the waiting room and lands it in the same session once approved', async () => {
    const key = keyPair();
    const f = deps({
      streams: { 50562: { target: { account: 'alice' }, source: { ip: '203.0.113.5', port: 4242 }, openedAt: 't' } },
    });
    const { session } = connect(f.deps, 'x', key);
    const channel = shell(session);
    await vi.waitFor(() => expect(channel.out).toContain('not approved for remote access yet'));
    expect(channel.out).toContain(`key    ${key.fingerprint}`);
    expect(channel.out).toContain('from   203.0.113.5');
    expect(channel.out).toContain('code   ABCD-EFGH');
    expect(f.deps.authority.openRoom).toHaveBeenCalledWith(
      { fingerprint: key.fingerprint, keyType: 'ssh-ed25519', publicKey: `ssh-ed25519 ${key.blob.toString('base64')}` },
      { ip: '203.0.113.5', port: 4242 },
    );
    expect(f.execs).toHaveLength(0);

    f.approve(key.fingerprint);
    await vi.waitFor(() => expect(f.execs).toHaveLength(1));
    expect(channel.out).toContain('Approved. Connecting…\r\n');
    expect(channel.out).toContain('Attaching to sandbox alice');
  });

  it('refuses a connection the host relayed no stream for, and a runtime that cannot hand over a terminal', async () => {
    const key = keyPair();
    const f = deps({ approved: [key.fingerprint] });
    const { session } = connect(f.deps, 'x', key);
    const channel = shell(session);
    await vi.waitFor(() => expect(channel.exitCode).toBe(1));
    expect(channel.err).toMatch(/no target/);

    const g = deps({
      approved: [key.fingerprint],
      noStream: true,
      streams: { 50562: { target: { account: 'alice' }, openedAt: 't' } },
    });
    const { session: other } = connect(g.deps, 'x', key);
    const plain = shell(other);
    await vi.waitFor(() => expect(plain.exitCode).toBe(1));
    expect(plain.err).toMatch(/cannot hand over a terminal/);
  });

  it(`caps sessions at ${MAX_SESSIONS} and ends a live session when its key is revoked`, async () => {
    const key = keyPair();
    const f = deps({
      approved: [key.fingerprint],
      streams: { 50562: { target: { account: 'alice', sandbox: 'demo' }, openedAt: 't' } },
    });
    const channels: FakeChannel[] = [];
    for (let i = 0; i < MAX_SESSIONS; i++) channels.push(shell(connect(f.deps, 'x', key).session));
    await vi.waitFor(() => expect(f.execs).toHaveLength(MAX_SESSIONS));
    const { session, client } = connect(f.deps, 'x', key);
    const overflow = shell(session);
    await vi.waitFor(() => expect(overflow.exitCode).toBe(1));
    expect(overflow.err).toMatch(/Too many terminal sessions/);

    f.ends.get(key.fingerprint)!();
    await settle();
    const ended = channels.filter((c) => c.ended);
    expect(ended.length).toBeGreaterThanOrEqual(1);
    expect(ended[0].err).toMatch(/revoked/);
    // The door hung the terminal's program up itself: the terminal is put back, once.
    expect(ended[0].out.split(TERMINAL_RESET)).toHaveLength(2);
    await settle();
    expect(ended[0].out).not.toContain('[nanoclaw] session ended');
    expect(f.execs.some((e) => e.exec.closed)).toBe(true);
    expect(client.ended).toBe(false);
  });

  it('hangs the exec up when the channel closes, and rejects forwarding, subsystems and a second program', async () => {
    const key = keyPair();
    const f = deps({
      approved: [key.fingerprint],
      streams: { 50562: { target: { account: 'alice' }, openedAt: 't' } },
    });
    const { client, session } = connect(f.deps, 'x', key);
    const reject = vi.fn();
    client.emit('tcpip', vi.fn(), reject, {});
    client.emit('openssh.streamlocal', vi.fn(), reject, {});
    client.emit('request', vi.fn(), reject, 'tcpip-forward', {});
    session.emit('sftp', vi.fn(), reject);
    session.emit('subsystem', vi.fn(), reject, { name: 'sftp' });
    session.emit('x11', vi.fn(), reject, {});
    session.emit('auth-agent', vi.fn(), reject);
    session.emit('env', vi.fn(), reject, { key: 'X', val: 'y' });
    expect(reject).toHaveBeenCalledTimes(8);
    const channel = shell(session);
    session.emit('shell', vi.fn(), reject);
    expect(reject).toHaveBeenCalledTimes(9);
    await vi.waitFor(() => expect(f.execs).toHaveLength(1));
    channel.emit('close');
    await settle();
    expect(f.execs[0].exec.closed).toBe(true);
    // The client left first: there is nobody to put a terminal back for.
    await settle();
    expect(channel.out).not.toContain(TERMINAL_RESET);
    expect(channel.out).not.toContain('[nanoclaw] session ended');
  });
});

describe('a connection that ends while its terminal is still being set up', () => {
  it('starts no exec when the key is revoked during a cold attach, and frees the session slot', async () => {
    const key = keyPair();
    let land!: (target: AttachTarget) => void;
    const attaching = new Promise<AttachTarget>((resolve) => {
      land = resolve;
    });
    const execStream = vi.fn(async (_command: string[], options: SessionExecOptions) => new FakeExec(options.tty));
    const f = deps({
      approved: [key.fingerprint],
      streams: { 50562: { target: { account: 'alice', sandbox: 'cold' }, openedAt: 't' } },
    });
    f.deps.sandboxes = { ...f.deps.sandboxes, attach: vi.fn(() => attaching) };
    const { session, client } = connect(f.deps, 'x', key);
    const channel = shell(session);
    await settle();
    expect(f.live()).toBe(1);

    f.ends.get(key.fingerprint)!();
    await settle();
    expect(channel.err).toMatch(/revoked/);
    expect(client.ended).toBe(true);
    expect(f.live()).toBe(0);

    // The sandbox wakes after the revocation: nothing is started for it.
    land({ containerName: 'ncl-cold', command: ['tmux', 'attach', 'cold'], execStream });
    await settle();
    await settle();
    expect(execStream).not.toHaveBeenCalled();
    expect(f.live()).toBe(0);
  });

  it('hangs up an exec that resolves after the client left or was revoked, on both endings', async () => {
    for (const ending of ['close', 'revoke'] as const) {
      const key = keyPair();
      const started: FakeExec[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const f = deps({
        approved: [key.fingerprint],
        streams: { 50562: { target: { account: 'alice', sandbox: 'slow' }, openedAt: 't' } },
      });
      const target: AttachTarget = {
        containerName: 'ncl-slow',
        command: ['tmux', 'attach', 'slow'],
        execStream: async (_command, options) => {
          await gate;
          const exec = new FakeExec(options.tty);
          started.push(exec);
          return exec;
        },
      };
      f.deps.sandboxes = { ...f.deps.sandboxes, attach: vi.fn(async () => target) };
      const { session, client } = connect(f.deps, 'x', key);
      const channel = shell(session);
      await settle();
      expect(f.live()).toBe(1);

      if (ending === 'close') channel.emit('close');
      else f.ends.get(key.fingerprint)!();
      await settle();
      expect(f.live()).toBe(0);
      if (ending === 'revoke') expect(client.ended).toBe(true);

      release();
      await settle();
      await settle();
      expect(started).toHaveLength(1);
      expect(started[0].closed).toBe(true);
      expect(f.live()).toBe(0);
    }
  });
});
