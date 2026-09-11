/**
 * The terminal a session hands its program to. The PTY case runs as this
 * unprivileged test user with no system group requirement: node-pty
 * allocates the pair itself and never chowns the slave, which is what lets
 * the door run on a host whose user is not in `tty`.
 */
import { describe, expect, it } from 'vitest';

import { ensureSpawnHelper, spawnPlain, spawnPty, type TerminalProgram } from './pty.js';

function collect(program: TerminalProgram): Promise<{ out: string; err: string; code: number }> {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    program.onData((data) => (out += String(data)));
    program.onStderr((data) => (err += String(data)));
    program.onExit((code) => resolve({ out, err, code }));
  });
}

describe('spawnPty', () => {
  it('allocates a terminal for an unprivileged user without any group membership, sized and resizable', async () => {
    expect(process.getuid?.()).not.toBe(0);
    const program = await spawnPty(
      { bin: '/bin/sh', args: ['-c', 'tty; stty size; sleep 0.3; stty size'] },
      { cols: 100, rows: 30, term: 'xterm' },
    );
    setTimeout(() => program.resize(120, 40), 100);
    const { out, code } = await collect(program);
    expect(code).toBe(0);
    expect(out).toMatch(/\/dev\/(pts\/\d+|ttys\d+)/);
    expect(out).toContain('30 100');
    expect(out).toContain('40 120');
  });

  it('feeds input and ends the program on kill', async () => {
    const program = await spawnPty(
      { bin: '/bin/sh', args: ['-c', 'read line; echo "got $line"'] },
      { cols: 80, rows: 24, term: 'xterm' },
    );
    const result = collect(program);
    program.write('hello\n');
    const { out, code } = await result;
    expect(out).toContain('got hello');
    expect(code).toBe(0);

    const stuck = await spawnPty(
      { bin: '/bin/sh', args: ['-c', 'exec sleep 30'] },
      { cols: 80, rows: 24, term: 'xterm' },
    );
    const ended = collect(stuck);
    stuck.kill('SIGHUP');
    expect((await ended).code).toBe(128 + 1);
  });

  it('checks the spawn helper only once and tolerates repeated calls', () => {
    ensureSpawnHelper();
    ensureSpawnHelper();
  });
});

describe('spawnPlain', () => {
  it('pipes stdout and stderr separately and reports the exit code', async () => {
    const program = spawnPlain({ bin: '/bin/sh', args: ['-c', 'echo plain; echo oops >&2; exit 3'] });
    const { out, err, code } = await collect(program);
    expect(out).toBe('plain\n');
    expect(err).toBe('oops\n');
    expect(code).toBe(3);
  });

  it('reports a program that cannot be started', async () => {
    const program = spawnPlain({ bin: '/nonexistent/program', args: [] });
    expect((await collect(program)).code).toBe(127);
  });
});
