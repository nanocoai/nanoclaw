/**
 * TmuxSession unit tests drive the CLI seam with a fake exec; the
 * integration suite at the bottom exercises real tmux (skipped where the
 * binary is absent — the image installs it, dev machines usually have it).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, test } from 'bun:test';

import { shQuote, TmuxSession, type TmuxExec, type TmuxExecResult } from './tmux-session.js';

const OK: TmuxExecResult = { exitCode: 0, stdout: '', stderr: '' };

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-session-test-'));
}

interface FakeExec {
  exec: TmuxExec;
  calls: string[][];
  envs: (Record<string, string> | undefined)[];
  /** Override the response for a subcommand (matched on argv[2]). */
  respond: (subcommand: string, result: TmuxExecResult) => void;
}

function fakeExec(): FakeExec {
  const calls: string[][] = [];
  const envs: (Record<string, string> | undefined)[] = [];
  const responses = new Map<string, TmuxExecResult>();
  return {
    calls,
    envs,
    respond: (subcommand, result) => void responses.set(subcommand, result),
    exec: async (argv, opts) => {
      calls.push(argv);
      envs.push(opts?.env);
      // argv = ['tmux', '-S', sock, <subcommand>, ...] — new-session rides
      // behind '-f conf', so scan for the first non-flag token after the sock.
      const subcommand = argv.slice(3).find((a) => !a.startsWith('-') && !a.endsWith('.conf'));
      return responses.get(subcommand ?? '') ?? OK;
    },
  };
}

function session(fake: FakeExec, dir: string, overrides: Partial<ConstructorParameters<typeof TmuxSession>[0]> = {}) {
  return new TmuxSession({
    command: 'claude',
    args: ['--model', 'sonnet'],
    cwd: '/workspace/group',
    env: { PATH: '/bin', SECRET: 'x' },
    socketPath: path.join(dir, 'tmux.sock'),
    confPath: path.join(dir, 'tmux.conf'),
    restartDelayMs: 20,
    maxRestartDelayMs: 80,
    healthyRunMs: 10_000,
    pollMs: 30,
    exec: fake.exec,
    ...overrides,
  });
}

const disposables: TmuxSession[] = [];
afterEach(() => {
  for (const s of disposables.splice(0)) s.dispose();
});

describe('shQuote', () => {
  test('wraps and escapes for the shell round trip tmux makes', () => {
    expect(shQuote('plain')).toBe(`'plain'`);
    expect(shQuote(`it's`)).toBe(`'it'\\''s'`);
    expect(shQuote('a b')).toBe(`'a b'`);
  });
});

describe('TmuxSession (fake exec)', () => {
  test('start creates a detached session with quoted command, geometry, cwd — and env only there', async () => {
    const fake = fakeExec();
    const dir = tempDir();
    const s = session(fake, dir);
    disposables.push(s);
    await s.start();

    const create = fake.calls[0];
    expect(create.slice(0, 3)).toEqual(['tmux', '-S', path.join(dir, 'tmux.sock')]);
    expect(create).toContain('new-session');
    expect(create).toContain('-d');
    expect(create[create.indexOf('-s') + 1]).toBe('agent');
    expect(create[create.indexOf('-c') + 1]).toBe('/workspace/group');
    expect(create[create.length - 1]).toBe(`'claude' '--model' 'sonnet'`);
    expect(fake.envs[0]).toMatchObject({ SECRET: 'x' });
    expect(s.running).toBe(true);
    expect(s.lastSpawnAt).toBeGreaterThan(0);
    // The generated conf carries the technical floor.
    const conf = fs.readFileSync(path.join(dir, 'tmux.conf'), 'utf8');
    expect(conf).toContain('remain-on-exit on');
    expect(conf).toContain('terminal-overrides ",*:RGB"');
  });

  test('onSpawn fires per life and a failed create throws', async () => {
    const fake = fakeExec();
    fake.respond('new-session', { exitCode: 1, stdout: '', stderr: 'duplicate session' });
    const spawns: number[] = [];
    const s = session(fake, tempDir(), { onSpawn: (at) => spawns.push(at) });
    disposables.push(s);
    await expect(s.start()).rejects.toThrow('duplicate session');
    expect(spawns).toHaveLength(0);
  });

  test('write sends hex octets in order and chunks long payloads', async () => {
    const fake = fakeExec();
    const s = session(fake, tempDir());
    disposables.push(s);
    await s.start();
    fake.calls.length = 0;

    const paste = `\x1b[200~${'a'.repeat(300)}\x1b[201~\r`;
    s.write(paste);
    // Drain the write chain.
    await new Promise((r) => setTimeout(r, 20));

    const sends = fake.calls.filter((c) => c.includes('send-keys'));
    expect(sends.length).toBeGreaterThan(1); // >256 octets → chunked
    const octets = sends.flatMap((c) => c.slice(c.indexOf('-H') + 1));
    const rebuilt = Buffer.from(octets.map((h) => parseInt(h, 16)));
    expect(rebuilt.toString('utf8')).toBe(paste); // byte-faithful, ordered
  });

  test('a dead pane respawns with backoff, onSpawn re-fires, lastSpawnAt moves', async () => {
    const fake = fakeExec();
    const spawns: number[] = [];
    const s = session(fake, tempDir(), { onSpawn: (at) => spawns.push(at) });
    disposables.push(s);
    await s.start();
    const firstSpawn = s.lastSpawnAt;

    fake.respond('list-panes', { exitCode: 0, stdout: '1\n', stderr: '' });
    await new Promise((r) => setTimeout(r, 40)); // one poll observes the death
    expect(s.running).toBe(false);
    fake.respond('list-panes', { exitCode: 0, stdout: '0\n', stderr: '' });
    await new Promise((r) => setTimeout(r, 60)); // backoff elapses, respawn-pane runs

    expect(fake.calls.some((c) => c.includes('respawn-pane'))).toBe(true);
    expect(spawns).toHaveLength(2);
    expect(s.lastSpawnAt).toBeGreaterThanOrEqual(firstSpawn);
    expect(s.running).toBe(true);
  });

  test('C13 fallback: a first life dead before healthyRunMs respawns with the fallback pane command', async () => {
    const fake = fakeExec();
    const s = session(fake, tempDir(), { args: ['--continue'], fallbackArgs: [] });
    disposables.push(s);
    await s.start();
    // The create-time pane command carried the resume flag…
    const create = fake.calls.find((c) => c.includes('new-session'))!;
    expect(create[create.length - 1]).toBe("'claude' '--continue'");

    fake.respond('list-panes', { exitCode: 0, stdout: '1\n', stderr: '' });
    await new Promise((r) => setTimeout(r, 40)); // one poll observes the death
    fake.respond('list-panes', { exitCode: 0, stdout: '0\n', stderr: '' });
    await new Promise((r) => setTimeout(r, 60)); // backoff elapses, respawn-pane runs

    // …and the respawn carries the SWAPPED command explicitly: a bare
    // respawn-pane would re-run the create-time `--continue` argv forever.
    const respawn = fake.calls.find((c) => c.includes('respawn-pane'))!;
    expect(respawn[respawn.length - 1]).toBe("'claude'");
    expect(s.running).toBe(true);
  });

  test('C13 fallback: a healthy first life keeps its argv — respawn-pane stays bare', async () => {
    const fake = fakeExec();
    const s = session(fake, tempDir(), { args: ['--continue'], fallbackArgs: [], healthyRunMs: 0 });
    disposables.push(s);
    await s.start();

    fake.respond('list-panes', { exitCode: 0, stdout: '1\n', stderr: '' });
    await new Promise((r) => setTimeout(r, 40));
    fake.respond('list-panes', { exitCode: 0, stdout: '0\n', stderr: '' });
    await new Promise((r) => setTimeout(r, 60));

    const respawn = fake.calls.find((c) => c.includes('respawn-pane'))!;
    expect(respawn[respawn.length - 1]).toBe('agent'); // no command — tmux re-runs create-time argv
  });

  test('a vanished server falls back to a full new-session respawn', async () => {
    const fake = fakeExec();
    const s = session(fake, tempDir());
    disposables.push(s);
    await s.start();
    fake.calls.length = 0;

    fake.respond('list-panes', { exitCode: 1, stdout: '', stderr: 'no server running' });
    await new Promise((r) => setTimeout(r, 40));
    fake.respond('list-panes', OK);
    await new Promise((r) => setTimeout(r, 60));

    expect(fake.calls.filter((c) => c.includes('new-session')).length).toBe(1);
    expect(s.running).toBe(true);
  });

  test('dispose kills the server and stops writes', async () => {
    const fake = fakeExec();
    const s = session(fake, tempDir());
    await s.start();
    s.dispose();
    const kills = fake.calls.filter((c) => c.includes('kill-server'));
    expect(kills).toHaveLength(1);
    fake.calls.length = 0;
    s.write('after');
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.calls).toHaveLength(0);
  });
});

const tmuxAvailable = Bun.which('tmux') !== null;

describe.if(tmuxAvailable)('TmuxSession (real tmux)', () => {
  test('bytes reach the pane process verbatim and a killed child respawns', async () => {
    const dir = tempDir();
    const rx = path.join(dir, 'rx');
    const pidFile = path.join(dir, 'pid');
    // stty raw -echo: the pane tty must not cook our bytes — the paste
    // wrapper and CR are the payload under test. The pid file is written
    // AFTER stty so its existence proves raw mode is up: bytes written
    // before that land in a cooked tty and the test would race itself.
    const s = new TmuxSession({
      command: 'sh',
      args: ['-c', `stty raw -echo; echo $$ > ${pidFile}; exec cat > ${rx}`],
      cwd: dir,
      env: { ...process.env } as Record<string, string>,
      socketPath: path.join(dir, 'tmux.sock'),
      confPath: path.join(dir, 'tmux.conf'),
      restartDelayMs: 50,
      pollMs: 50,
    });
    disposables.push(s);
    await s.start();
    const readyDeadline = Date.now() + 5_000;
    while (!fs.existsSync(pidFile) && Date.now() < readyDeadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(fs.existsSync(pidFile)).toBe(true);

    const paste = `\x1b[200~hello over tmux\x1b[201~\r`;
    s.write(paste);
    const deadline = Date.now() + 5_000;
    let got = '';
    while (Date.now() < deadline) {
      try {
        got = fs.readFileSync(rx, 'utf8');
        if (got.length >= paste.length) break;
      } catch {
        // pane still booting
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(got).toBe(paste);

    // Kill the child; remain-on-exit holds the pane and the watcher respawns.
    const firstPid = fs.readFileSync(pidFile, 'utf8').trim();
    const firstSpawnAt = s.lastSpawnAt;
    process.kill(Number(firstPid), 'SIGKILL');
    const respawnDeadline = Date.now() + 8_000;
    while (Date.now() < respawnDeadline) {
      const pid = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : firstPid;
      if (pid !== firstPid && s.lastSpawnAt > firstSpawnAt && s.running) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(s.lastSpawnAt).toBeGreaterThan(firstSpawnAt);
    expect(s.running).toBe(true);
  }, 20_000);
});
