import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('runs the CLI when the checkout path contains a space', () => {
    root = mkdtempSync(join(tmpdir(), 'nanoclaw entry '));
    const script = join(root, 'skill-directives.ts');
    copyFileSync('scripts/skill-directives.ts', script);
    mkdirSync(join(root, 'skill'));
    writeFileSync(join(root, 'skill', 'SKILL.md'), '# Fixture\n');

    const run = spawnSync(resolve('node_modules/.bin/tsx'), [script, join(root, 'skill')], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ directives: [] });
  });
});
