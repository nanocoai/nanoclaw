/**
 * One connection through the session handler with ssh2's objects faked:
 * the authentication decisions (public key only, any username, signatures
 * checked, unknown keys admitted), the session requests (PTY, resize,
 * shell, exec, refused forwarding and subsystems), the waiting room in
 * session, the session cap, and revocation ending a live session.
 */
import { EventEmitter } from 'node:events';
import ssh2, { type ClientInfo, type Connection, type ParsedKey, type Session } from 'ssh2';
import { describe, expect, it, vi } from 'vitest';

import { fingerprintOf } from './keys.js';
import type { AttachExec } from './landing.js';
import type { TerminalProgram } from './pty.js';
import { handleConnection, MAX_SESSIONS, type SessionDeps } from './session.js';
import type { DoorStream } from './target-map.js';

const { utils } = ssh2;

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

class FakeProgram implements TerminalProgram {
  data = new EventEmitter();
  written = '';
  resized: [number, number][] = [];
  killed: string[] = [];
  write(data: Buffer | string): void {
    this.written += String(data);
  }
  end(): void {}
  resize(cols: number, rows: number): void {
    this.resized.push([cols, rows]);
  }
  kill(signal?: NodeJS.Signals): void {
    this.killed.push(signal ?? 'SIGTERM');
  }
  pause(): void {}
  resume(): void {}
  onData(listener: (data: Buffer | string) => void): void {
    this.data.on('data', listener);
  }
  onStderr(): void {}
  onExit(listener: (code: number) => void): void {
    this.data.on('exit', listener);
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
  const ctx = {
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
  return ctx;
}

const exec = (name: string): AttachExec => ({
  bin: 'docker',
  argsTty: ['exec', '-it', name, 'tmux'],
  argsPlain: ['exec', '-i', name, 'tmux'],
});

function deps(overrides: Partial<SessionDeps> & { approved?: string[]; streams?: Record<number, DoorStream> } = {}) {
  const approved = new Set(overrides.approved ?? []);
  const ends = new Map<string, () => void>();
  const programs: FakeProgram[] = [];
  const logs: { level: string; message: string; data?: Record<string, unknown> }[] = [];
  let live = 0;
  let waiters: ((approved: boolean) => void)[] = [];
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
      attach: vi.fn(async (name: string) => exec(name)),
      create: vi.fn(async (name: string) => exec(name)),
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
    spawnPty: vi.fn(async () => {
      const program = new FakeProgram();
      programs.push(program);
      return program;
    }),
    spawnPlain: vi.fn(() => {
      const program = new FakeProgram();
      programs.push(program);
      return program;
    }),
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
    programs,
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

describe('authentication', () => {
  it('offers public key only and ignores the username', () => {
    const d = deps().deps;
    const client = new FakeClient();
    handleConnection(client as unknown as Connection, INFO, d);
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
  it('lands an approved key in its stream’s sandbox under a PTY, resizes, and exits with the program', async () => {
    const key = keyPair();
    const f = deps({
      approved: [key.fingerprint],
      streams: { 50562: { target: { account: 'alice', sandbox: 'demo' }, openedAt: 't' } },
    });
    const { session, client } = connect(f.deps, 'whoever', key);
    const channel = shell(session);
    await vi.waitFor(() => expect(f.programs).toHaveLength(1));
    expect(f.deps.spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({ bin: 'docker', args: ['exec', '-it', 'demo', 'tmux'] }),
      { cols: 120, rows: 40, term: 'xterm-256color' },
    );
    expect(channel.out).toContain('Attaching to sandbox demo — detach with Ctrl-b then d.\r\n');
    expect(f.live()).toBe(1);

    session.emit('window-change', vi.fn(), vi.fn(), { cols: 200, rows: 50, width: 0, height: 0 });
    expect(f.programs[0].resized).toEqual([[200, 50]]);
    channel.emit('data', Buffer.from('ls\r'));
    expect(f.programs[0].written).toBe('ls\r');
    f.programs[0].data.emit('data', 'hello from tmux');
    expect(channel.out).toContain('hello from tmux');

    f.programs[0].data.emit('exit', 3);
    await settle();
    expect(channel.exitCode).toBe(3);
    expect(channel.ended).toBe(true);
    expect(f.live()).toBe(0);
    expect(f.logs.some((l) => l.message === 'Remote terminal login' && l.data?.username === 'whoever')).toBe(true);
    expect(client.ended).toBe(false);
  });

  it('runs `ls` as an exec without a PTY and refuses other commands', async () => {
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
    expect(f.programs).toHaveLength(0);

    const { session: again } = connect(f.deps, 'x', key);
    const other = new FakeChannel();
    again.emit('exec', () => other, vi.fn(), { command: 'bash' });
    await vi.waitFor(() => expect(other.exitCode).toBe(2));
    expect(other.err).toMatch(/usage/);
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
    expect(f.programs).toHaveLength(0);

    f.approve(key.fingerprint);
    await vi.waitFor(() => expect(f.programs).toHaveLength(1));
    expect(channel.out).toContain('Approved. Connecting…\r\n');
    expect(channel.out).toContain('Attaching to sandbox alice');
  });

  it('refuses a connection the host relayed no stream for, after authentication', async () => {
    const key = keyPair();
    const f = deps({ approved: [key.fingerprint] });
    const { session } = connect(f.deps, 'x', key);
    const channel = shell(session);
    await vi.waitFor(() => expect(channel.exitCode).toBe(1));
    expect(channel.err).toMatch(/no target/);
  });

  it(`caps sessions at ${MAX_SESSIONS} and ends a live session when its key is revoked`, async () => {
    const key = keyPair();
    const f = deps({
      approved: [key.fingerprint],
      streams: { 50562: { target: { account: 'alice', sandbox: 'demo' }, openedAt: 't' } },
    });
    const channels: FakeChannel[] = [];
    for (let i = 0; i < MAX_SESSIONS; i++) channels.push(shell(connect(f.deps, 'x', key).session));
    await vi.waitFor(() => expect(f.programs).toHaveLength(MAX_SESSIONS));
    const { session, client } = connect(f.deps, 'x', key);
    const overflow = shell(session);
    await vi.waitFor(() => expect(overflow.exitCode).toBe(1));
    expect(overflow.err).toMatch(/Too many terminal sessions/);

    f.ends.get(key.fingerprint)!();
    await settle();
    const ended = channels.filter((c) => c.ended);
    expect(ended.length).toBeGreaterThanOrEqual(1);
    expect(ended[0].err).toMatch(/revoked/);
    expect(f.programs.some((p) => p.killed.includes('SIGHUP'))).toBe(true);
    expect(client.ended).toBe(false);
  });

  it('rejects forwarding, subsystems and a second program on the same session', async () => {
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
    shell(session);
    session.emit('shell', vi.fn(), reject);
    expect(reject).toHaveBeenCalledTimes(9);
  });
});
