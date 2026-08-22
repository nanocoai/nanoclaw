import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'nanoclaw-install-github-'));
  roots.push(root);
  mkdirSync(join(root, 'setup'), { recursive: true });
  mkdirSync(join(root, 'src/channels'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  copyFileSync(join(process.cwd(), 'setup/install-github.sh'), join(root, 'setup/install-github.sh'));
  writeFileSync(join(root, 'src/channels/index.ts'), '');
  writeFileSync(join(root, 'src/channels/github.ts'), 'existing\n');
  writeFileSync(join(root, 'package.json'), '{}\n');
  return root;
}

function writeExecutable(root: string, name: string, body: string): void {
  const file = join(root, 'bin', name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

function runInstaller(root: string) {
  return spawnSync('bash', ['setup/install-github.sh'], {
    cwd: root,
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` },
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('install-github channel copy', () => {
  it('preserves the destination and removes the temporary file when git show fails', () => {
    const root = makeFixture();
    writeExecutable(root, 'git', 'if [ "$1" = fetch ]; then exit 0; fi\nexit 1');

    const result = runInstaller(root);

    expect(result.status).not.toBe(0);
    expect(readFileSync(join(root, 'src/channels/github.ts'), 'utf8')).toBe('existing\n');
    expect(readdirSync(join(root, 'src/channels')).filter((name) => name.startsWith('.github.ts.'))).toEqual([]);
  });

  it('replaces the destination only after git show succeeds', () => {
    const root = makeFixture();
    writeExecutable(
      root,
      'git',
      'if [ "$1" = fetch ]; then exit 0; fi\nif [ "$1" = show ]; then printf "from git\\n"; exit 0; fi\nexit 1',
    );
    writeExecutable(root, 'pnpm', 'exit 0');

    const result = runInstaller(root);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(root, 'src/channels/github.ts'), 'utf8')).toBe('from git\n');
    expect(readdirSync(join(root, 'src/channels')).filter((name) => name.startsWith('.github.ts.'))).toEqual([]);
  });
});
