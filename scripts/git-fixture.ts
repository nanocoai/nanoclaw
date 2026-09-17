/**
 * Git isolation for fixture repositories created by tests.
 *
 * A fixture repo inherits the operator's global git config, and several settings
 * commonly found there break its commits on an ordinary developer machine:
 *
 * - `core.hooksPath` — a global hooks directory applies to every repo on the
 *   machine, including a throwaway fixture under the temp dir. A policy
 *   pre-commit hook that refuses commits outside a sanctioned checkout fails
 *   every commit a fixture makes.
 * - `commit.gpgsign` / `tag.gpgsign` — signing needs the operator's key, which in
 *   a test run is either unavailable ("failed to write commit object") or
 *   prompts for hardware confirmation that nobody is there to give.
 * - `merge.verifySignatures` — the code under test merges, and an unsigned
 *   fixture commit is then refused with "does not have a GPG signature".
 * - `core.excludesFile` — a global ignore file that happens to match a fixture
 *   path makes `git add .` skip it silently, so the fixture is built wrong
 *   rather than failing loudly.
 *
 * Isolation happens in two phases, because these settings do not all apply at
 * the same time:
 *
 * 1. `FIXTURE_GIT_FLAGS` covers commands that run BEFORE there is a repo to
 *    configure. `git clone` checks out a working tree and speaks a transport
 *    while creating the repo, so `core.autocrlf` has already rewritten line
 *    endings and `protocol.file.allow=never` has already refused a local-path
 *    clone by the time any repo-local config could exist.
 * 2. `isolateFixtureRepo` covers everything afterwards, as repo-local config.
 *
 * LOAD-BEARING, two ways:
 *
 * 1. Phase 2 settings are written to the fixture's own config rather than passed
 *    as `-c` overrides on the test's git calls, because the code under test
 *    spawns git itself. Only repo-local config reaches those child processes.
 * 2. Do not replace either phase with environment variables (`GIT_CONFIG_GLOBAL`
 *    and friends), whether set in the test runner or exported by the caller.
 *    That makes a green suite a property of how it was invoked, so the next
 *    contributor without the magic env line sees the same failures again.
 *
 * The two phases together are narrower than blanking the global config
 * wholesale: they neutralize the settings that are known to reach these
 * fixtures, not every setting that could. A fixture that starts failing because
 * of some other global setting belongs here, as one more line.
 *
 * Call `isolateFixtureRepo` on every fixture repo right after `git init` or
 * `git clone`; config is per-repo, and a clone does not inherit its source's
 * local settings.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

/** Identity used for fixture commits, so the operator's own is never required. */
const FIXTURE_AUTHOR = { name: 'Test', email: 'test@example.com' } as const;

/**
 * Prefix for `git init` and `git clone`, which act before `isolateFixtureRepo`
 * can. Splice it in ahead of the subcommand: `git`, `[...FIXTURE_GIT_FLAGS,
 * 'clone', source, target]`.
 */
export const FIXTURE_GIT_FLAGS: readonly string[] = [
  // Fixtures assert on file contents and parse `nc:` directive fences; CRLF
  // rewriting at checkout time corrupts both.
  '-c',
  'core.autocrlf=false',
  // Fixtures clone each other over local paths.
  '-c',
  'protocol.file.allow=always',
];

function config(root: string, key: string, value: string): void {
  execFileSync('git', ['config', key, value], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Detach one fixture repository from the operator's global git config.
 *
 * `root` is the repo's working tree, or the repository directory itself for a
 * bare clone. The hooks and excludes paths deliberately point at files that do
 * not exist: git treats a missing hook or ignore file as "nothing to apply", so
 * neither has to be created or cleaned up. Both are resolved to absolute paths,
 * because git resolves a relative `core.hooksPath` against the git process's
 * working directory rather than the repository.
 */
export function isolateFixtureRepo(root: string): void {
  config(root, 'core.hooksPath', path.resolve(root, 'nanoclaw-fixture-no-hooks'));
  config(root, 'core.excludesFile', path.resolve(root, 'nanoclaw-fixture-no-excludes'));
  config(root, 'core.autocrlf', 'false');
  // The code under test fetches and clones between fixtures over local paths.
  config(root, 'protocol.file.allow', 'always');
  config(root, 'commit.gpgsign', 'false');
  config(root, 'tag.gpgsign', 'false');
  config(root, 'merge.verifySignatures', 'false');
  config(root, 'user.name', FIXTURE_AUTHOR.name);
  config(root, 'user.email', FIXTURE_AUTHOR.email);
}
