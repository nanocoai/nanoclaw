import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// The CLI scripts' "am I the entry point?" check compared import.meta.url (a
// percent-encoded URL) with a raw `file://` + argv[1], so a checkout path with
// a space in it made every one of them exit 0 having done nothing.
describe('CLI entry-point check', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function runFrom(dir: string): ReturnType<typeof spawnSync> {
    mkdirSync(join(dir, 'skill'), { recursive: true });
    writeFileSync(join(dir, 'skill', 'SKILL.md'), '# Fixture\n');
    return spawnSync(resolve('node_modules/.bin/tsx'), [join(dir, 'skill-directives.ts'), join(dir, 'skill')], {
      encoding: 'utf8',
    });
  }

  it('runs the CLI when the checkout path contains a space', () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'nanoclaw entry ')));
    copyFileSync('scripts/skill-directives.ts', join(root, 'skill-directives.ts'));
    const run = runFrom(root);
    expect(run.status).toBe(0);
    expect(JSON.parse(String(run.stdout))).toMatchObject({ directives: [] });
  }, 20_000);

  it('runs the CLI when the checkout is reached through a symlink', () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'nanoclaw-entry-')));
    mkdirSync(join(root, 'real'));
    copyFileSync('scripts/skill-directives.ts', join(root, 'real', 'skill-directives.ts'));
    symlinkSync(join(root, 'real'), join(root, 'link'));
    const run = runFrom(join(root, 'link'));
    expect(run.status).toBe(0);
    expect(JSON.parse(String(run.stdout))).toMatchObject({ directives: [] });
  }, 20_000);

  it('does not throw on import when argv[1] is not a file', async () => {
    const argv1 = process.argv[1];
    process.argv[1] = join(tmpdir(), 'nanoclaw-no-such-entry');
    try {
      await expect(import('./skill-directives.js')).resolves.toBeDefined();
    } finally {
      process.argv[1] = argv1;
    }
  });
});
