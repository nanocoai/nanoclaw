/**
 * Dependency guard for the Vercel CLI integration point (host tree, vitest).
 *
 * add-vercel installs the `vercel` CLI into the agent image by appending to
 * `container/cli-tools.json`, and drops its container skill into
 * `container/skills/vercel-cli/`. A globally-installed CLI binary is not
 * importable or typed, so neither `tsc` nor a runtime import can catch its
 * removal — only an image build would, and the skill's validate step does not
 * rebuild the image in CI. This structural test stands in for that leg.
 *
 * It checks both halves, because either alone is a broken install: a manifest
 * entry with no skill leaves the agent a binary it was never told about, and a
 * skill with no manifest entry tells the agent to run a command that is not
 * there.
 *
 * Supersedes `vercel-dockerfile.test.ts`, which asserted an `ARG VERCEL_VERSION`
 * / `pnpm install -g vercel@…` pair in the Dockerfile. That shape stopped
 * existing when cli-tools.json took over the global CLIs, so the old guard was
 * asserting against a file that no longer decides anything.
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
  ) as Array<{ name: string; version: string }>;

  it('appears in the CLI manifest', () => {
    expect(manifest.map((t) => t.name)).toContain('vercel');
  });

  it('is pinned to an exact version, so the supply-chain policy still applies', () => {
    const vercel = manifest.find((t) => t.name === 'vercel');
    expect(vercel?.version).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  });

  it('ships its container skill, so the agent knows the CLI is there', () => {
    expect(fs.existsSync(path.join(root, 'container', 'skills', 'vercel-cli', 'SKILL.md'))).toBe(
      true,
    );
  });
});
