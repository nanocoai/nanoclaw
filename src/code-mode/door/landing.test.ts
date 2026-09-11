/**
 * The landing decision table and the landing program around it, with the
 * target map, the host socket and the terminal exec all faked.
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResponseFrame } from '../../cli/frame.js';
import { decideLanding } from './landing-decision.js';
import { clientPortFromSshConnection, runLanding, type LandingIo } from './landing.js';
import { doorFiles } from './paths.js';
import { writeDoorState, type DoorState } from './state.js';
import type { DoorStream, DoorTarget } from './target-map.js';

const DIR = `/tmp/nanoclaw-door-landing-${process.pid}`;
const files = doorFiles(DIR);
const FP = 'SHA256:gOakZC+YL189IEEAB60qLI8r+5H3H4lj4iMh5hlYOSo';

const state: DoorState = {
  version: 1,
  enabled: true,
  name: 'alice',
  doorPort: 33022,
  approvalUrl: 'https://example.test/terminals',
  socketPath: '/srv/host/data/ncl.sock',
  hostSocketPath: files.hostSocket,
  path: '/opt/homebrew/bin:/usr/bin:/bin',
  updatedAt: '2026-09-11T12:00:00Z',
};

const attachFrame = (name: string): ResponseFrame => ({
  id: 'r',
  ok: true,
  data: {
    attachExec: { bin: 'docker', argsTty: ['exec', '-it', name, 'tmux'], argsPlain: ['exec', '-i', name, 'tmux'] },
    group: name,
    containerName: name,
  },
});
const listFrame = (names: string[], human?: string): ResponseFrame => ({
  id: 'r',
  ok: true,
  data: names.map((sandbox) => ({ sandbox, id: `ag-${sandbox}` })),
  ...(human ? { human } : {}),
});
const errorFrame = (message: string): ResponseFrame => ({
  id: 'r',
  ok: false,
  error: { code: 'handler-error', message },
});

interface Fakes {
  io: LandingIo;
  out: string[];
  err: string[];
  frames: { command: string; args: Record<string, unknown> }[];
  execs: { bin: string; args: string[]; env: NodeJS.ProcessEnv }[];
}

const streamFor = (target: DoorTarget): DoorStream => ({ target, openedAt: '2026-09-11T12:00:00.000Z' });

function fakes(opts: {
  target?: DoorTarget | Error;
  sandboxes?: string[];
  listHuman?: string;
  attach?: ResponseFrame;
  env?: NodeJS.ProcessEnv;
  tty?: boolean;
}): Fakes {
  const f: Fakes = { out: [], err: [], frames: [], execs: [], io: undefined as unknown as LandingIo };
  f.io = {
    env: opts.env ?? { SSH_CONNECTION: '127.0.0.1 50562 127.0.0.1 45000', PATH: '/usr/bin:/bin' },
    pid: 4242,
    stdinIsTty: opts.tty ?? true,
    write: (t) => f.out.push(t),
    fail: (t) => f.err.push(t),
    exec: (bin, args, env) => {
      f.execs.push({ bin, args, env });
      return 7;
    },
    fetchTarget: vi.fn(async () => {
      if (opts.target instanceof Error) throw opts.target;
      return opts.target && streamFor(opts.target);
    }),
    postSession: vi.fn(async () => {}),
    sendFrame: vi.fn(async (_socket, command, args) => {
      f.frames.push({ command, args });
      if (command === 'sandboxes-list') return listFrame(opts.sandboxes ?? [], opts.listHuman);
      return opts.attach ?? attachFrame(String(args.id ?? args.name));
    }),
  };
  return f;
}

beforeEach(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  await writeDoorState(files.state, state);
});
afterEach(() => fs.rmSync(DIR, { recursive: true, force: true }));

describe('decideLanding', () => {
  it.each([
    [undefined, ['alice'], 'refuse'],
    [{ account: 'alice', sandbox: 'demo' }, [], 'attach:demo'],
    [{ account: 'alice', sandbox: 'demo' }, ['alice', 'demo'], 'attach:demo'],
    [{ account: 'alice' }, ['alice'], 'attach:alice'],
    [{ account: 'alice' }, ['other'], 'new:alice'],
    [{ account: '' }, [], 'refuse'],
  ] as const)('%j with sandboxes %j → %s', (target, existing, expected) => {
    const decision = decideLanding(target && streamFor(target as DoorTarget), existing);
    expect(
      decision.verb === 'refuse' || decision.verb === 'list' ? decision.verb : `${decision.verb}:${decision.name}`,
    ).toBe(expected);
  });

  it('turns `ls`/`list` into a listing and refuses any other command with usage (exit 2)', () => {
    const stream = streamFor({ account: 'alice' });
    expect(decideLanding(stream, [], 'ls')).toEqual({ verb: 'list' });
    expect(decideLanding(stream, [], ' list ')).toEqual({ verb: 'list' });
    expect(decideLanding(stream, [], 'bash')).toMatchObject({ verb: 'refuse', code: 2 });
    expect(decideLanding(undefined, [], 'ls')).toMatchObject({ verb: 'refuse', code: 1 });
  });
});

describe('clientPortFromSshConnection', () => {
  it('reads the second field and rejects malformed values', () => {
    expect(clientPortFromSshConnection('127.0.0.1 50562 127.0.0.1 45000')).toBe(50562);
    expect(clientPortFromSshConnection('::1 1 ::1 2')).toBe(1);
    expect(clientPortFromSshConnection(undefined)).toBeUndefined();
    expect(clientPortFromSshConnection('127.0.0.1 x 127.0.0.1 45000')).toBeUndefined();
    expect(clientPortFromSshConnection('127.0.0.1 50562')).toBeUndefined();
  });
});

describe('runLanding', () => {
  it('attaches a named sandbox target through the host and hands the terminal over with the host PATH', async () => {
    const f = fakes({ target: { account: 'alice', sandbox: 'demo' } });
    expect(await runLanding([DIR, FP], f.io)).toBe(7);
    expect(f.io.fetchTarget).toHaveBeenCalledWith(files.hostSocket, 50562);
    expect(f.io.postSession).toHaveBeenCalledWith(files.hostSocket, { pid: 4242, fingerprint: FP, port: 50562 });
    expect(f.frames).toEqual([{ command: 'sandboxes-attach', args: { id: 'demo' } }]);
    expect(f.execs).toEqual([
      { bin: 'docker', args: ['exec', '-it', 'demo', 'tmux'], env: expect.objectContaining({ PATH: state.path }) },
    ]);
    expect(f.out.join('')).toContain('Attaching to sandbox demo');
  });

  it('creates the account default sandbox on first use, attaches it afterwards', async () => {
    const first = fakes({ target: { account: 'alice' }, sandboxes: [] });
    expect(await runLanding([DIR, FP], first.io)).toBe(7);
    expect(first.frames.map((f) => f.command)).toEqual(['sandboxes-list', 'sandboxes-new']);
    expect(first.frames[1].args).toEqual({ name: 'alice' });
    expect(first.out.join('')).toContain('Creating sandbox alice');

    const again = fakes({ target: { account: 'alice' }, sandboxes: ['alice'] });
    expect(await runLanding([DIR, FP], again.io)).toBe(7);
    expect(again.frames.map((f) => f.command)).toEqual(['sandboxes-list', 'sandboxes-attach']);
  });

  it('prefers a target handed over by the waiting room, survives a failed session registration, and uses plain argv without a TTY', async () => {
    const f = fakes({ target: new Error('must not be asked'), tty: false });
    vi.mocked(f.io.postSession).mockRejectedValue(new Error('socket gone'));
    expect(await runLanding([DIR, FP, JSON.stringify(streamFor({ account: 'alice', sandbox: 'demo' }))], f.io)).toBe(7);
    expect(f.io.fetchTarget).not.toHaveBeenCalled();
    expect(f.execs[0].args).toEqual(['exec', '-i', 'demo', 'tmux']);
  });

  it('refuses a connection the host has no target for, without contacting the host', async () => {
    const f = fakes({ target: undefined });
    expect(await runLanding([DIR, FP], f.io)).toBe(1);
    expect(f.err.join('')).toMatch(/no target/);
    expect(f.frames).toEqual([]);
    expect(f.execs).toEqual([]);
    expect(f.io.postSession).not.toHaveBeenCalled();
  });

  it('reports a target lookup failure, a host error frame, and an unreachable host', async () => {
    const lookup = fakes({ target: new Error('socket gone') });
    expect(await runLanding([DIR, FP], lookup.io)).toBe(1);
    expect(lookup.err.join('')).toMatch(/socket gone/);

    const gone = fakes({
      target: { account: 'alice', sandbox: 'gone' },
      attach: errorFrame("no sandbox 'gone' — create it"),
    });
    expect(await runLanding([DIR, FP], gone.io)).toBe(1);
    expect(gone.err.join('')).toBe('sandbox gone no longer exists\n');

    const cold = fakes({
      target: { account: 'alice', sandbox: 'demo' },
      attach: errorFrame('container did not come up'),
    });
    expect(await runLanding([DIR, FP], cold.io)).toBe(1);
    expect(cold.err.join('')).toContain('container did not come up');

    const down = fakes({ target: { account: 'alice', sandbox: 'demo' } });
    vi.mocked(down.io.sendFrame).mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await runLanding([DIR, FP], down.io)).toBe(1);
    expect(down.err.join('')).toMatch(/not reachable.*ECONNREFUSED/);
  });

  it('lists sandboxes for `ssh <address> ls` and refuses other commands', async () => {
    const env = { SSH_CONNECTION: '127.0.0.1 50562 127.0.0.1 45000', SSH_ORIGINAL_COMMAND: 'ls' };
    const ls = fakes({
      target: { account: 'alice', sandbox: 'demo' },
      sandboxes: ['alice', 'demo'],
      listHuman: 'SANDBOX\nalice\ndemo',
      env,
    });
    expect(await runLanding([DIR, FP], ls.io)).toBe(0);
    expect(ls.frames.map((f) => f.command)).toEqual(['sandboxes-list']);
    expect(ls.out.join('')).toBe('SANDBOX\nalice\ndemo\n');
    expect(ls.execs).toEqual([]);

    const other = fakes({ target: { account: 'alice' }, env: { ...env, SSH_ORIGINAL_COMMAND: 'bash -i' } });
    expect(await runLanding([DIR, FP], other.io)).toBe(2);
    expect(other.err.join('')).toMatch(/usage/);
    expect(other.frames.map((f) => f.command)).toEqual(['sandboxes-list']);
  });

  it('refuses when remote access is disabled or the arguments are missing', async () => {
    await writeDoorState(files.state, { ...state, enabled: false });
    const f = fakes({ target: { account: 'alice' } });
    expect(await runLanding([DIR, FP], f.io)).toBe(1);
    expect(f.err.join('')).toMatch(/disabled/);
    expect(await runLanding([DIR], f.io)).toBe(2);
  });
});
