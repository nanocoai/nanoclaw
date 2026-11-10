import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { restartHost } from './host-restart.js';

const roots: string[] = [];
const tempRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-host-restart-'));
  roots.push(root);
  return root;
};

/** A checkout whose `pnpm` and `restart.sh` only record that they ran and exit as told. */
function checkout(buildExit: number, restartExit: number, restartSays = ''): string {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, 'bin'));
  fs.mkdirSync(path.join(root, 'setup/lib'), { recursive: true });
  const record = (step: string, exit: number, says = '') =>
    `#!/bin/sh\necho ${step} >> "${root}/ran"\n${says && `echo '${says}' >&2\n`}exit ${exit}\n`;
  fs.writeFileSync(path.join(root, 'bin/pnpm'), record('build:$*', buildExit), { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'setup/lib/restart.sh'), record('restart', restartExit, restartSays));
  vi.stubEnv('PATH', `${path.join(root, 'bin')}:${process.env.PATH}`);
  return root;
}
const ran = (root: string) => fs.readFileSync(path.join(root, 'ran'), 'utf8').trim().split('\n');

/** restartHost in its own process, so what restart.sh writes to the shared stderr shows. */
function stderrOf(root: string): string {
  const script = `import { restartHost } from ${JSON.stringify(path.resolve('setup/lib/host-restart.ts'))};
    restartHost(process.argv.at(-1));`;
  const res = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script, root], {
    encoding: 'utf8',
  });
  expect(res.status, res.stderr).toBe(0);
  return res.stderr;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe.runIf(process.platform !== 'win32')('host restart', () => {
  const build = 'build:run build --noEmitOnError';
  it.each([
    [0, 0, { status: 'restarted' }, [build, 'restart']],
    [2, 0, { status: 'failed', step: 'build', message: 'pnpm run build --noEmitOnError exited 2' }, [build]],
    [0, 1, { status: 'failed', step: 'restart', message: 'bash setup/lib/restart.sh exited 1' }, [build, 'restart']],
    [0, 2, { status: 'no-service' }, [build, 'restart']],
  ])('build exits %i, restart exits %i', (buildExit, restartExit, result, steps) => {
    const root = checkout(buildExit, restartExit);
    expect(restartHost(root)).toEqual(result);
    expect(ran(root)).toEqual(steps);
  });

  it("leaves no-service to the caller to say, and still shows restart.sh's other errors", () => {
    expect(stderrOf(checkout(0, 2, 'NanoClaw service is not installed.'))).not.toContain('not installed');
    expect(stderrOf(checkout(0, 1, 'launchctl: bootstrap failed'))).toContain('launchctl: bootstrap failed');
  });

  it('keeps the last good dist/ when the build has a type error', () => {
    const root = tempRoot();
    // `pnpm run build <flags>` is `tsc <flags>` here. Never a real pnpm in a temp dir: it can prune a linked node_modules.
    fs.mkdirSync(path.join(root, 'bin'));
    const tsc = path.resolve('node_modules/.bin/tsc');
    fs.writeFileSync(path.join(root, 'bin/pnpm'), `#!/bin/sh\nshift 2\nexec '${tsc}' "$@"\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${path.join(root, 'bin')}:${process.env.PATH}`);
    const compilerOptions = { outDir: 'dist', rootDir: 'src', types: [], skipLibCheck: true };
    fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions, include: ['src'] }));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/index.ts'), "export const port: number = 'not a number';\n");
    fs.mkdirSync(path.join(root, 'dist'));
    fs.writeFileSync(path.join(root, 'dist/index.js'), '// last good build\n');
    const result = restartHost(root);
    expect(fs.readFileSync(path.join(root, 'dist/index.js'), 'utf8')).toBe('// last good build\n');
    expect(result).toMatchObject({ status: 'failed', step: 'build' });
  });
});
