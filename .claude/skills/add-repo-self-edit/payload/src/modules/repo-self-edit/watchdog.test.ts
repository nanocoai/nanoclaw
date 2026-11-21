/**
 * scripts/repo-self-edit-watchdog.sh — the rollback path for host edits.
 *
 * Runs the real script in a throwaway repo. The build (`pnpm`), the service
 * restart (`setup/lib/restart.sh`) and the host probe
 * (`setup/lib/host-status.mjs`) are stubs whose outcome each case picks; git
 * and the result marker are real.
 */
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/repo-self-edit-watchdog.sh',
);

let repo: string;
let bin: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

function write(file: string, content: string, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
}

/** Commit an edit the way the host module does, returning its sha. */
function commitEdit(): string {
  write(path.join(repo, 'src/router.ts'), 'export const a = 2;\n');
  git('commit', '-qam', 'self-edit: bump a');
  return git('rev-parse', 'HEAD').trim();
}

function runWatchdog(sha: string, env: { build: 'ok' | 'fail'; instances: string }): Record<string, unknown> {
  const r = spawnSync('bash', [path.join(repo, 'scripts/repo-self-edit-watchdog.sh'), sha, 'sess-1'], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      REPO_SELF_EDIT_SETTLE_S: '0',
      STUB_BUILD: env.build,
      STUB_INSTANCES: env.instances,
    },
  });
  const marker = path.join(repo, 'data/repo-self-edit-result.json');
  expect(
    fs.existsSync(marker),
    r.stderr + fs.readFileSync(path.join(repo, 'logs/repo-self-edit-watchdog.log'), 'utf8'),
  ).toBe(true);
  return JSON.parse(fs.readFileSync(marker, 'utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-self-edit-watchdog-'));
  bin = path.join(repo, '.stub-bin');
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  write(path.join(repo, '.gitignore'), 'data/\nlogs/\n.stub-bin/\n.probe-count\n');
  write(path.join(repo, 'src/router.ts'), 'export const a = 1;\n');
  write(path.join(repo, 'scripts/repo-self-edit-watchdog.sh'), fs.readFileSync(SCRIPT, 'utf8'), 0o755);
  write(path.join(repo, 'setup/lib/restart.sh'), '#!/usr/bin/env bash\nexit 0\n', 0o755);
  // Prints the next instance id from STUB_INSTANCES ("i1,i1" healthy, "i1,i2" crash loop).
  write(
    path.join(repo, 'setup/lib/host-status.mjs'),
    `import fs from 'fs';
const f = '.probe-count';
const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0;
fs.writeFileSync(f, String(n + 1));
console.log(process.env.STUB_INSTANCES.split(',')[n] ?? 'gone');
`,
  );
  // First build of the edit follows STUB_BUILD; builds after a revert succeed.
  write(
    path.join(bin, 'pnpm'),
    `#!/usr/bin/env bash
if [ "$1" = run ] && [ "$2" = build ]; then
  if grep -q 'a = 2' src/router.ts && [ "$STUB_BUILD" = fail ]; then echo "TS2322 in router.ts"; exit 2; fi
fi
exit 0
`,
    0o755,
  );
  git('add', '-A');
  git('commit', '-qm', 'base');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('repo self-edit watchdog', () => {
  it('keeps a commit that builds and stays up', () => {
    const sha = commitEdit();
    const result = runWatchdog(sha, { build: 'ok', instances: 'i1,i1' });
    expect(result).toMatchObject({ ok: true, sessionId: 'sess-1', newSha: sha, revertSha: null });
    expect(git('rev-parse', 'HEAD').trim()).toBe(sha);
  });

  it('reverts a commit that does not build, leaving other staged work alone', () => {
    const sha = commitEdit();
    write(path.join(repo, 'src/staged.ts'), 'staged elsewhere\n');
    git('add', 'src/staged.ts');

    const result = runWatchdog(sha, { build: 'fail', instances: 'i1,i1' });

    expect(result.ok).toBe(false);
    expect(result.revertSha).toBe(git('rev-parse', 'HEAD').trim());
    expect(String(result.detail)).toContain('TS2322');
    expect(fs.readFileSync(path.join(repo, 'src/router.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(git('log', '-1', '--format=%s')).toBe('Revert "self-edit: bump a"\n');
    expect(git('status', '--porcelain')).toContain('A  src/staged.ts');
  });

  it('reverts a commit whose host crash-loops after the restart', () => {
    const sha = commitEdit();
    const result = runWatchdog(sha, { build: 'ok', instances: 'i1,i2,i3,i3' });
    expect(result.ok).toBe(false);
    expect(result.revertSha).toBeTruthy();
    expect(String(result.detail)).toContain('did not come back healthy');
    expect(fs.readFileSync(path.join(repo, 'src/router.ts'), 'utf8')).toBe('export const a = 1;\n');
  });
});
