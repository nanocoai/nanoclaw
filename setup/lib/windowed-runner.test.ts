import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  rawLog: '',
  step: vi.fn(),
  emit: vi.fn(),
  logSuccess: vi.fn(),
  logError: vi.fn(),
  brightSelect: vi.fn(),
  cancel: vi.fn(),
  offerClaude: vi.fn(),
}));
vi.mock('../logs.js', () => ({ stepRawLog: () => fixture.rawLog, step: fixture.step }));
vi.mock('./diagnostics.js', () => ({ emit: fixture.emit }));
vi.mock('./claude-handoff.js', () => ({ offerClaudeOnFailure: fixture.offerClaude }));
vi.mock('./bright-select.js', () => ({ brightSelect: fixture.brightSelect }));
vi.mock('@clack/prompts', () => ({
  log: { success: fixture.logSuccess, error: fixture.logError, warn: vi.fn() },
  isCancel: (value: unknown) => typeof value === 'symbol',
  cancel: fixture.cancel,
}));

import { spawnQuiet, STOP_GRACE_MS } from './runner.js';
import { runWindowedChild } from './windowed-runner.js';

const LABELS = { running: 'Rebuilding…', done: 'Rebuilt.', failed: 'Rebuild failed.' };
let dir: string;
let terminal: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windowed-child-'));
  fixture.rawLog = path.join(dir, '07-container-rebuild.log');
  terminal = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    terminal += String(chunk);
    return true;
  });
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    terminal += `${args.join(' ')}\n`;
  });
});
afterEach(() => {
  killTrees();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A node child that prints `count` numbered lines to stderr (where build.sh sends docker's output). */
function noisyChild(count: number, exit = 0): [string, string[]] {
  const script = `for (let i = 1; i <= ${count}; i++) console.error('build line ' + i); process.exit(${exit});`;
  return [process.execPath, ['-e', script]];
}

/**
 * A silent child that starts a grandchild, like build.sh starting docker, and
 * writes both pids to a file. The grandchild holds the output pipes. Both give
 * up after 20 s so a failing run leaves nothing behind.
 */
function buildTree(): { script: string; pids: () => number[] } {
  const pidFile = path.join(dir, 'tree.pids');
  const script =
    `const g = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'inherit' });` +
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, process.pid + ' ' + g.pid);` +
    `setTimeout(() => process.exit(1), 20000);`;
  const pids = (): number[] =>
    fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf-8').trim().split(' ').map(Number) : [];
  trees.push(pids);
  return { script, pids };
}
const trees: Array<() => number[]> = [];

/** Running, not a zombie waiting to be reaped. */
function isRunning(pid: number): boolean {
  const stat = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf-8' }).stdout.trim();
  return stat !== '' && !stat.startsWith('Z');
}

// Captured before any test fakes timers.
const realSetTimeout = globalThis.setTimeout;
const realSleep = (ms: number): Promise<void> => new Promise((r) => realSetTimeout(r, ms));

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !check(); i++) await realSleep(10);
  expect(check()).toBe(true);
}

/** Records re-raises at setup itself (and whether the tree still ran); other kills go through. */
function spyOnSelfKill(tree: { pids: () => number[] }): Array<{ signal: unknown; treeRunning: boolean }> {
  const realKill = process.kill.bind(process);
  const calls: Array<{ signal: unknown; treeRunning: boolean }> = [];
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid !== process.pid) return realKill(pid, signal);
    calls.push({ signal, treeRunning: tree.pids().some(isRunning) });
    return true;
  });
  return calls;
}

function killTrees(): void {
  for (const pids of trees.splice(0)) {
    for (const pid of pids()) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
}

/** The rows a terminal shows for the window's output: text, \r, \n, cursor up and erase line. */
function screenRows(output: string): string[] {
  const rows = [''];
  let row = 0;
  let col = 0;
  // eslint-disable-next-line no-control-regex
  for (const [, n, cmd, text] of output.matchAll(/\x1b\[\??([\d;]*)([A-Za-z])|(\r|\n|[^\x1b\r\n]+)/g)) {
    if (cmd === 'A') row = Math.max(0, row - Number(n || 1));
    else if (cmd === 'K') rows[row] = '';
    else if (text === '\r') col = 0;
    else if (text === '\n') [row, col] = [row + 1, 0];
    else if (text) {
      const line = (rows[row] ?? '').padEnd(col);
      rows[row] = line.slice(0, col) + text + line.slice(col + text.length);
      col += text.length;
    }
    rows[row] ??= '';
  }
  return rows;
}

describe('runWindowedChild', () => {
  it('keeps the full output in the raw log and shows only a rolling tail on the terminal', async () => {
    const [cmd, args] = noisyChild(12);
    const res = await runWindowedChild('container-rebuild', cmd, args, LABELS, { cwd: dir });

    expect(res).toMatchObject({ ok: true, exitCode: 0, rawLog: fixture.rawLog });
    const log = fs.readFileSync(fixture.rawLog, 'utf-8');
    for (let i = 1; i <= 12; i++) expect(log).toContain(`build line ${i}\n`);
    // Window rows are gutter-prefixed redraws; no line reaches the terminal bare.
    expect(terminal).toContain('build line 12');
    expect(terminal).not.toMatch(/(^|\n)build line \d+/);
    expect(fixture.logSuccess).toHaveBeenCalledWith(expect.stringContaining('Rebuilt.'));
    expect(fixture.step).toHaveBeenCalledWith('container-rebuild', 'success', expect.any(Number), {}, fixture.rawLog);
    expect(fixture.emit).toHaveBeenCalledWith(
      'step_completed',
      expect.objectContaining({ step: 'container-rebuild', status: 'success' }),
    );
  });

  it('runs the child in the given working directory', async () => {
    const res = await runWindowedChild(
      'container-rebuild',
      process.execPath,
      ['-e', 'console.log(process.cwd())'],
      LABELS,
      { cwd: dir },
    );
    expect(res.transcript.trim()).toBe(fs.realpathSync(dir));
  });

  it('reports a failed exit and dumps the output tail below the failure line', async () => {
    const [cmd, args] = noisyChild(3, 7);
    const res = await runWindowedChild('container-rebuild', cmd, args, LABELS);

    expect(res).toMatchObject({ ok: false, exitCode: 7 });
    expect(res.signal).toBeUndefined();
    expect(fixture.logError).toHaveBeenCalledWith(expect.stringContaining('Rebuild failed.'));
    expect(terminal).toContain('build line 3');
    expect(fixture.step).toHaveBeenCalledWith('container-rebuild', 'failed', expect.any(Number), {}, fixture.rawLog);
  });

  it('reports the signal that killed the child', async () => {
    const res = await runWindowedChild(
      'container-rebuild',
      process.execPath,
      ['-e', "process.kill(process.pid, 'SIGTERM')"],
      LABELS,
    );
    expect(res).toMatchObject({ ok: false, signal: 'SIGTERM' });
  });

  it('fails the step instead of crashing when the command cannot start', async () => {
    const res = await runWindowedChild('container-rebuild', path.join(dir, 'missing.sh'), [], LABELS);
    expect(res.ok).toBe(false);
    expect(res.error).toBeInstanceOf(Error);
    expect(fixture.logError).toHaveBeenCalledWith(expect.stringContaining('Rebuild failed.'));
  });

  it('listens for signals only while the window is up', async () => {
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    const before = signals.map((s) => process.listenerCount(s));
    const run = runWindowedChild('container-rebuild', process.execPath, ['-e', 'setTimeout(() => {}, 200)'], LABELS);
    expect(signals.map((s) => process.listenerCount(s))).toEqual(before.map((n) => n + 1));
    await run;
    expect(signals.map((s) => process.listenerCount(s))).toEqual(before);
  });

  it('on a signal, stops the whole build tree, then re-raises the signal', async () => {
    const tree = buildTree();
    const reraised = spyOnSelfKill(tree);
    const stdin = process.stdin as unknown as Record<string, unknown>;
    const saved = { isTTY: stdin.isTTY, isRaw: stdin.isRaw, setRawMode: stdin.setRawMode };
    const setRawMode = vi.fn();
    Object.assign(stdin, { isTTY: true, isRaw: true, setRawMode });
    const sigterms = process.listenerCount('SIGTERM');
    const run = runWindowedChild('container-rebuild', process.execPath, ['-e', tree.script], LABELS);
    try {
      await until(() => tree.pids().length === 2);
      terminal = '';
      process.emit('SIGTERM', 'SIGTERM');
      expect(terminal).toBe('\x1b[?25h');
      expect(setRawMode).toHaveBeenCalledWith(false);
      expect(reraised).toEqual([]);
      // Still listening, so a second signal can't kill setup (Node's default) while the tree stops.
      expect(process.listenerCount('SIGTERM')).toBe(sigterms + 1);
      process.emit('SIGTERM', 'SIGTERM');
      const res = await run;
      expect(res.signal).toBe('SIGTERM');
      expect(reraised).toEqual([{ signal: 'SIGTERM', treeRunning: false }]);
    } finally {
      // Let the re-raise land on the spy even when an assertion failed.
      killTrees();
      await run;
      Object.assign(stdin, saved);
    }
  });

  it("clears the tty's ^C echo along with the window before re-raising", async () => {
    const tree = buildTree();
    const realKill = process.kill.bind(process);
    let atReraise: string[] | undefined;
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid !== process.pid) return realKill(pid, signal);
      atReraise = screenRows(terminal).filter(Boolean); // a real process dies here
      return true;
    });
    const run = runWindowedChild('container-rebuild', process.execPath, ['-e', tree.script], LABELS);
    try {
      await until(() => tree.pids().length === 2);
      expect(screenRows(terminal).join('\n')).toContain('Rebuilding…');
      // What a tty writes at the cursor on Ctrl-C; SIGTERM stands in for the SIGINT, as above.
      terminal += '^C';
      process.emit('SIGTERM', 'SIGTERM');
      await run;
      expect(atReraise).toEqual([]);
    } finally {
      killTrees();
      await run;
    }
  });

  it('re-raises a signal once the tree is gone, without waiting for a Claude look', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    fixture.brightSelect.mockResolvedValueOnce('help');
    let endLook!: () => void;
    fixture.offerClaude.mockImplementationOnce(() => new Promise<void>((resolve) => (endLook = resolve)));
    const tree = buildTree();
    const reraised = spyOnSelfKill(tree);
    const run = runWindowedChild('container-rebuild', process.execPath, ['-e', tree.script], LABELS);
    try {
      await until(() => tree.pids().length === 2);
      await vi.advanceTimersByTimeAsync(65_000);
      await until(() => fixture.offerClaude.mock.calls.length === 1);
      process.emit('SIGTERM', 'SIGTERM');
      await until(() => reraised.length === 1);
      expect(reraised).toEqual([{ signal: 'SIGTERM', treeRunning: false }]);
    } finally {
      killTrees();
      endLook?.();
      await run;
    }
  });

  it('re-raises at once a signal that arrives after the build ended, during a Claude look', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    fixture.brightSelect.mockResolvedValueOnce('help');
    let endLook!: () => void;
    fixture.offerClaude.mockImplementationOnce(() => new Promise<void>((resolve) => (endLook = resolve)));
    // Silent until the test creates the gate file, so the stall prompt opens.
    const gate = path.join(dir, 'go');
    const pidFile = path.join(dir, 'child.pid');
    const script =
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
      `setTimeout(() => process.exit(1), 20000);` +
      `setInterval(() => { if (require('fs').existsSync(${JSON.stringify(gate)})) process.exit(0); }, 20);`;
    const pids = (): number[] => (fs.existsSync(pidFile) ? [Number(fs.readFileSync(pidFile, 'utf-8'))] : []);
    trees.push(pids);
    const reraised = spyOnSelfKill({ pids });
    const run = runWindowedChild('container-rebuild', process.execPath, ['-e', script], LABELS);
    try {
      await until(() => pids().length === 1);
      await vi.advanceTimersByTimeAsync(65_000);
      await until(() => fixture.offerClaude.mock.calls.length === 1);
      fs.writeFileSync(gate, '');
      await until(() => !isRunning(pids()[0]));
      await realSleep(200);
      process.emit('SIGTERM', 'SIGTERM');
      expect(reraised).toEqual([{ signal: 'SIGTERM', treeRunning: false }]);
    } finally {
      endLook?.();
      await run;
    }
  });

  // At the stall prompt stdin is in raw mode, so Ctrl-C arrives as a key and
  // cancels the prompt; no signal reaches the build. Esc cancels the same way.
  it.each([
    ['Ctrl-C', '\x03'],
    ['Esc', '\x1b'],
  ])('%s at the stall prompt stops the whole build tree before setup exits', async (_key, bytes) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const actual = await vi.importActual<typeof import('./bright-select.js')>('./bright-select.js');
    fixture.brightSelect.mockImplementation(actual.brightSelect);
    const tree = buildTree();
    const exits: boolean[] = [];
    vi.spyOn(process, 'exit').mockImplementation((() => {
      exits.push(tree.pids().some(isRunning));
    }) as typeof process.exit);

    const run = runWindowedChild('container-rebuild', process.execPath, ['-e', tree.script], LABELS);
    await until(() => tree.pids().length === 2);
    await vi.advanceTimersByTimeAsync(65_000);
    await until(() => terminal.includes('What now?'));
    expect(tree.pids().every(isRunning)).toBe(true);
    process.stdin.emit('data', Buffer.from(bytes));
    const res = await run;

    expect(exits).toEqual([false]);
    expect(fixture.cancel).toHaveBeenCalledWith('Setup cancelled.');
    expect(res).toMatchObject({ ok: false, signal: 'SIGINT' });
  });

  // The stall prompt reads stdin. Left open after the step ends, it would
  // take the next step's keypresses, and "Keep waiting" would redraw a window
  // over that step's prompt.
  it('closes an unanswered stall prompt when the step ends', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    let promptSignal: AbortSignal | undefined;
    fixture.brightSelect.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          promptSignal = signal;
          signal.addEventListener('abort', () => resolve(Symbol('clack:cancel')));
        }),
    );
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as typeof process.exit);
    // Silent until the test creates the gate file; gives up after 20 s so a
    // failing run leaves no process behind.
    const gate = path.join(dir, 'go');
    const script =
      `setTimeout(() => process.exit(1), 20000);` +
      `setInterval(() => { if (require('fs').existsSync(${JSON.stringify(gate)})) process.exit(0); }, 20);`;
    const run = runWindowedChild('container-rebuild', process.execPath, ['-e', script], LABELS);

    await vi.advanceTimersByTimeAsync(65_000);
    for (let i = 0; i < 200 && !promptSignal; i++) await new Promise((r) => setTimeout(r, 10));
    expect(promptSignal?.aborted).toBe(false);
    fs.writeFileSync(gate, '');
    const res = await run;

    expect(res.ok).toBe(true);
    expect(promptSignal?.aborted).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    expect(fixture.logSuccess).toHaveBeenCalledWith(expect.stringContaining('Rebuilt.'));
    // Nothing hides the cursor or redraws the window after the final cursor restore.
    expect(terminal.slice(terminal.lastIndexOf('\x1b[?25h'))).toBe('\x1b[?25h');
  });
});

describe('spawnQuiet stop', () => {
  it('SIGKILLs a process group that ignores the stop signal once the grace period ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stop = new AbortController();
    let ignored!: () => void;
    const sawIgnore = new Promise<void>((resolve) => (ignored = resolve));
    const script =
      `process.on('SIGINT', () => console.log('ignored SIGINT'));` +
      `console.log('ready'); setInterval(() => {}, 1000); setTimeout(() => process.exit(1), 20000);`;
    const run = spawnQuiet(process.execPath, ['-e', script], fixture.rawLog, undefined, {
      stop: stop.signal,
      onLine: (line) => {
        if (line === 'ready') stop.abort('SIGINT');
        if (line === 'ignored SIGINT') ignored();
      },
    });

    await sawIgnore;
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS);
    expect(await run).toMatchObject({ ok: false, signal: 'SIGKILL' });
  });

  it('resolves only once a descendant that left the output pipes is gone too', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stop = new AbortController();
    // The grandchild has its own stdio and ignores SIGINT; its parent dies on SIGINT.
    const ready = path.join(dir, 'grandchild.pid');
    const grandchild =
      `process.on('SIGINT', () => {}); require('fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid));` +
      `setTimeout(() => {}, 20000);`;
    const script =
      `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });` +
      `console.log('child ' + process.pid); setTimeout(() => process.exit(1), 20000);`;
    let childPid = 0;
    let grandchildRunningAtResolve: boolean | undefined;
    const run = spawnQuiet(process.execPath, ['-e', script], fixture.rawLog, undefined, {
      stop: stop.signal,
      onLine: (line) => {
        if (line.startsWith('child ')) childPid = Number(line.slice(6));
      },
    });
    await until(() => childPid > 0 && fs.existsSync(ready) && fs.readFileSync(ready, 'utf-8') !== '');
    const grandchildPid = Number(fs.readFileSync(ready, 'utf-8'));
    trees.push(() => [childPid, grandchildPid]);
    void run.then(() => (grandchildRunningAtResolve = isRunning(grandchildPid)));

    stop.abort('SIGINT');
    await until(() => !isRunning(childPid));
    expect(isRunning(grandchildPid)).toBe(true);
    for (let i = 0; i < 100 && grandchildRunningAtResolve === undefined; i++) {
      await vi.advanceTimersByTimeAsync(100);
      await realSleep(5);
    }
    expect(grandchildRunningAtResolve).toBe(false);
    expect(await run).toMatchObject({ ok: false, signal: 'SIGINT' });
  });

  it('SIGKILLs the group at once when setup exits while it runs', async () => {
    const stop = new AbortController();
    const exitListeners = process.listeners('exit');
    const script =
      `process.on('SIGINT', () => {}); process.on('SIGTERM', () => {});` +
      `console.log('ready ' + process.pid); setTimeout(() => process.exit(1), 20000);`;
    let pid = 0;
    const run = spawnQuiet(process.execPath, ['-e', script], fixture.rawLog, undefined, {
      stop: stop.signal,
      onLine: (line) => {
        if (line.startsWith('ready ')) pid = Number(line.slice(6));
      },
    });
    await until(() => pid > 0);
    trees.push(() => [pid]);
    // Call only this child's listener: emitting 'exit' would reach vitest's own.
    const onExit = process.listeners('exit').find((listener) => !exitListeners.includes(listener));
    onExit?.(0);

    expect(await run).toMatchObject({ ok: false, signal: 'SIGKILL' });
    expect(process.listeners('exit')).toEqual(exitListeners);
  });
});
