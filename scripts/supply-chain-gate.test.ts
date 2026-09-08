import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// pnpm reads workspace settings from the top level; nested under `pnpm:` the gate is silently off.
describe('pnpm supply-chain gate', () => {
  it('minimumReleaseAge is a top-level pnpm-workspace.yaml setting', () => {
    const workspace = readFileSync('pnpm-workspace.yaml', 'utf8');
    expect(workspace).toMatch(/^minimumReleaseAge: 4320$/m);
    expect(workspace).not.toMatch(/^pnpm:/m);
  });
});
