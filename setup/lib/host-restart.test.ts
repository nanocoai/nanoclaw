import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { restartHost } from './host-restart.js';

const roots: string[] = [];

/** A checkout whose `pnpm` and `restart.sh` only record that they ran and exit as told. */
function checkout(buildExit: number, restartExit: number): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-host-restart-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'bin'));
  fs.mkdirSync(path.join(root, 'setup/lib'), { recursive: true });
  const record = (step: string, exit: number) => `#!/bin/sh\necho ${step} >> "${root}/ran"\nexit ${exit}\n`;
  fs.writeFileSync(path.join(root, 'bin/pnpm'), record('build:$*', buildExit), { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'setup/lib/restart.sh'), record('restart', restartExit));
  vi.stubEnv('PATH', `${path.join(root, 'bin')}:${process.env.PATH}`);
  return root;
}
const ran = (root: string) => fs.readFileSync(path.join(root, 'ran'), 'utf8').trim().split('\n');

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe.runIf(process.platform !== 'win32')('host restart', () => {
  it.each([
    [0, 0, { status: 'restarted' }, ['build:run build', 'restart']],
    [2, 0, { status: 'failed', message: 'pnpm run build exited 2' }, ['build:run build']],
    [0, 1, { status: 'failed', message: 'bash setup/lib/restart.sh exited 1' }, ['build:run build', 'restart']],
    [0, 2, { status: 'no-service' }, ['build:run build', 'restart']],
  ])('build exits %i, restart exits %i', (buildExit, restartExit, result, steps) => {
    const root = checkout(buildExit, restartExit);
    expect(restartHost(root)).toEqual(result);
    expect(ran(root)).toEqual(steps);
  });
});
