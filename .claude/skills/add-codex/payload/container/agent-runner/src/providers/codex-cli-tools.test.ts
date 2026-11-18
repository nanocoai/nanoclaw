// Structural guard for the Codex CLI install in container/cli-tools.json.
//
// @openai/codex is a CLI *binary* installed from the global-CLI manifest (a
// json-merge seam), not an importable package, so the barrel-driven
// registration tests cannot see it. This test reads the real cli-tools.json
// and asserts the @openai/codex entry is present and pinned to an exact
// version. It goes red if the manifest entry is dropped or unpins.
//
// Runs under bun (same suite as the container registration test):
//   cd container/agent-runner && bun test src/providers/codex-cli-tools.test.ts

import { existsSync, readFileSync } from 'fs';
import path from 'path';

import { describe, it, expect } from 'bun:test';

// container/agent-runner/src/providers/ -> container/cli-tools.json
const MANIFEST = path.join(import.meta.dir, '..', '..', '..', 'cli-tools.json');
const manifestPresent = existsSync(MANIFEST);

// Read lazily — `describe.skipIf` still runs the body to register tests, so the
// read has to be guarded for the bare-branch (no manifest) case.
const tools: Array<{ name: string; version: string }> = manifestPresent
  ? JSON.parse(readFileSync(MANIFEST, 'utf8'))
  : [];
const codex = tools.find((t) => t.name === '@openai/codex');

// cli-tools.json is a trunk file; on the bare providers branch it isn't present,
// so skip there. In an installed tree (trunk + this payload) it must carry the
// pinned @openai/codex entry.
describe.skipIf(!manifestPresent)('container/cli-tools.json codex CLI install', () => {
  it('includes the @openai/codex entry', () => {
    expect(codex).toBeDefined();
  });

  it('pins it to an exact semver (no latest, no ranges)', () => {
    expect(codex?.version).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  });
});
