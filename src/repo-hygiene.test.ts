import { execFileSync } from 'child_process';

import { describe, expect, it } from 'vitest';

/**
 * The tracked tree carries no symlinks beyond the two the repo owns. A
 * worktree convenience link (a `node_modules` pointing at some absolute local
 * path) that slips into a commit breaks every fresh checkout — install tools
 * hit a self-referencing link before they can run.
 */
const ALLOWED_SYMLINKS = new Set(['AGENTS.md', '.agents/skills']);

describe('repo hygiene', () => {
  it('tracks no symlinks outside the allowlist', () => {
    const listing = execFileSync('git', ['ls-files', '-s'], { encoding: 'utf8' });
    const symlinks = listing
      .split('\n')
      .filter((line) => line.startsWith('120000'))
      .map((line) => line.split('\t')[1]);
    expect(symlinks.filter((path) => !ALLOWED_SYMLINKS.has(path))).toEqual([]);
  });
});
