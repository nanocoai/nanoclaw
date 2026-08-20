/**
 * Dependency guard for the Vercel CLI integration point (host tree, vitest).
 *
 * add-vercel installs the `vercel` CLI into the agent image by appending to
 * `container/cli-tools.json`, and drops its container skill into
 * `container/skills/vercel-cli/`. A globally-installed CLI binary is not
 * importable or typed, so neither `tsc` nor a runtime import can catch its
 * removal. This structural test stands in for that leg.
 *
 * It checks both halves, because either alone is a broken install: a manifest
 * entry with no skill leaves the agent a binary it was never told about, and a
 * skill with no manifest entry tells the agent to run a command that is not
 * there.
 *
 * What it CANNOT see is the image. A green run here still permits the state
 * add-vercel's Phase 4 probes for separately — entry in the manifest, skill on
 * disk, no `vercel` binary in the built image because nobody rebuilt it. The
 * only check for that is `docker run --rm --entrypoint sh <image> -lc
 * 'command -v vercel'`, which is not something a unit test can carry.
 *
 * Assertion style is deliberately the same as `container/cli-tools.test.ts`,
 * the trunk-side guard for the same file: shape and pinning, expressed as
 * properties of the entry rather than by naming other tools. That test does not
 * deny-list tool names precisely so an appended `vercel` entry keeps it green —
 * both suites must be green after a successful install, and this file must not
 * assert anything that contradicts it.
 *
 * Supersedes `vercel-dockerfile.test.ts`, which asserted an `ARG VERCEL_VERSION`
 * / `pnpm install -g vercel@…` pair in the Dockerfile. That shape stopped
 * existing when cli-tools.json took over the global CLIs.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'vitest';

/** Repo root — the dir holding container/, wherever this file is copied to. */
function repoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'container', 'cli-tools.json'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('container/cli-tools.json not found walking up from ' + __dirname);
}

describe('the Vercel CLI is installed in the agent image', () => {
  const root = repoRoot();
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, 'container', 'cli-tools.json'), 'utf8'),
  ) as Array<{ name: string; version: string; onlyBuilt?: boolean }>;
  const vercel = manifest.find((t) => t.name === 'vercel');

  it('appears in the CLI manifest', () => {
    expect(manifest.map((t) => t.name)).toContain('vercel');
  });

  it('is pinned to an exact version, so the supply-chain policy still applies', () => {
    expect(vercel?.version).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  });

  it('carries only the keys the installer reads', () => {
    // `container/install-cli-tools.sh` consumes exactly name/version/onlyBuilt.
    // A fourth key is a typo that silently does nothing.
    for (const key of Object.keys(vercel ?? {})) {
      expect(['name', 'version', 'onlyBuilt']).toContain(key);
    }
  });

  it('ships its container skill, so the agent knows the CLI is there', () => {
    expect(fs.existsSync(path.join(root, 'container', 'skills', 'vercel-cli', 'SKILL.md'))).toBe(
      true,
    );
  });

  it('leaves the container skill as the only per-group install artifact', () => {
    // Shared skills reach a group as symlinks into the read-only /app/skills
    // mount (`syncSkillSymlinks`, src/container-runner.ts). A REAL directory at
    // that path shadows the mount permanently, which is what an rsync of
    // container/skills/ into the per-group store used to produce — freezing
    // every shared skill in that group, not just this one.
    const sessionsRoot = path.join(root, 'data', 'v2-sessions');
    if (!fs.existsSync(sessionsRoot)) return;
    for (const group of fs.readdirSync(sessionsRoot)) {
      const entry = path.join(sessionsRoot, group, '.claude-shared', 'skills', 'vercel-cli');
      let stat: fs.Stats | undefined;
      try {
        stat = fs.lstatSync(entry);
      } catch {
        continue;
      }
      expect(
        stat.isSymbolicLink(),
        `${entry} is a real directory — it shadows the /app/skills mount; see add-vercel Phase 5`,
      ).toBe(true);
    }
  });
});
