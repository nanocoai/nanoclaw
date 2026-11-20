import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const SHORT_CHILD = ['-c', 'echo first line; echo last line'];
vi.mock('child_process', async (importOriginal) => {
  const cp = await importOriginal<typeof import('child_process')>();
  // spawnStep runs `pnpm exec tsx setup/index.ts`; a short shell stands in.
  const spawn = ((cmd: string, args: string[], opts: object) =>
    cp.spawn(cmd === 'pnpm' ? 'sh' : cmd, cmd === 'pnpm' ? SHORT_CHILD : args, opts)) as typeof cp.spawn;
  return { ...cp, default: { ...cp, spawn }, spawn };
});
vi.mock('./claude-handoff.js', () => ({ offerClaudeOnFailure: vi.fn() }));
vi.mock('../logs.js', () => ({}));
vi.mock('./diagnostics.js', () => ({ emit: vi.fn() }));
import { spawnQuiet, spawnStep } from './runner.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-raw-log-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

it('keeps the step result instead of crashing when its raw log cannot be opened', async () => {
  const res = await spawnQuiet(process.execPath, ['-e', 'console.log("hi")'], path.join(dir, 'missing', 'raw.log'));
  expect(res).toMatchObject({ ok: true, exitCode: 0 });
  expect(res.transcript.trim()).toBe('hi');
});

it.each([
  ['spawnQuiet', (rawLog: string) => spawnQuiet('sh', SHORT_CHILD, rawLog)],
  ['spawnStep', (rawLog: string) => spawnStep('test-step', [], () => undefined, rawLog)],
])('%s resolves only once the raw log is written, even with the threadpool busy', async (_name, run) => {
  // Hold every threadpool thread, as a loaded CI runner can, so the log's
  // writes queue behind this work while a short child ends. One CPU budget
  // split across the threads keeps a large UV_THREADPOOL_SIZE fast.
  const jobs = Number(process.env.UV_THREADPOOL_SIZE) || 4;
  const iterations = Math.ceil(1_600_000 / jobs);
  const busy = Array.from(
    { length: jobs },
    () => new Promise((done) => crypto.pbkdf2('x', 'y', iterations, 64, 'sha512', done)),
  );
  const rawLog = path.join(dir, 'raw.log');
  const res = await run(rawLog);

  expect(res.exitCode).toBe(0);
  expect(fs.readFileSync(rawLog, 'utf-8')).toContain('last line\n');
  await Promise.all(busy);
});
