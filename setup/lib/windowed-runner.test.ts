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
}));
vi.mock('../logs.js', () => ({ stepRawLog: () => fixture.rawLog, step: fixture.step }));
vi.mock('./diagnostics.js', () => ({ emit: fixture.emit }));
vi.mock('./claude-handoff.js', () => ({ offerClaudeOnFailure: vi.fn() }));
vi.mock('./bright-select.js', () => ({ brightSelect: fixture.brightSelect }));
vi.mock('@clack/prompts', () => ({
  log: { success: fixture.logSuccess, error: fixture.logError, warn: vi.fn() },
  isCancel: (value: unknown) => typeof value === 'symbol',
  cancel: vi.fn(),
}));

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

  it('restores the cursor on Ctrl-C only while the window is up', async () => {
    const [int, term] = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const run = runWindowedChild('container-rebuild', process.execPath, ['-e', 'setTimeout(() => {}, 200)'], LABELS);
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual([int + 1, term + 1]);
    await run;
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual([int, term]);
  });

  it('on a signal, shows the cursor and leaves raw mode before re-raising it', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const stdin = process.stdin as unknown as Record<string, unknown>;
    const saved = { isTTY: stdin.isTTY, isRaw: stdin.isRaw, setRawMode: stdin.setRawMode };
    const setRawMode = vi.fn();
    Object.assign(stdin, { isTTY: true, isRaw: true, setRawMode });
    try {
      const run = runWindowedChild('container-rebuild', process.execPath, ['-e', 'setTimeout(() => {}, 200)'], LABELS);
      terminal = '';
      process.emit('SIGTERM', 'SIGTERM');
      expect(terminal).toBe('\x1b[?25h');
      expect(setRawMode).toHaveBeenCalledWith(false);
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
      await run;
    } finally {
      Object.assign(stdin, saved);
    }
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
