// Structural guard for the OpenCode CLI install in container/cli-tools.json.
//
// add-opencode installs the `opencode-ai` CLI globally in the agent container
// image via a json-merge entry in `container/cli-tools.json`, not a hand-edited
// Dockerfile layer. `opencode-ai` is a CLI *binary*, not an importable package,
// so the barrel-driven registration tests cannot see it — neither `tsc` nor a
// runtime import can catch its removal. This test reads the real
// cli-tools.json and asserts the opencode-ai entry is present and pinned to
// an exact version. It goes red if the manifest entry is dropped or unpins.
//
// Pinning matters here beyond reproducibility: the `opencode-ai` CLI version
// must match the `@opencode-ai/sdk` version the container provider imports.
// An unpinned `latest` would silently upgrade the CLI past the SDK's
// compatible range (1.14.x changes the session id format from UUID to a
// `ses_` prefix) and break sessions.
//
// Runs under bun (same suite as the container registration test):
//   cd container/agent-runner && bun test src/providers/opencode-cli-tools.test.ts

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
const opencode = tools.find((t) => t.name === 'opencode-ai');

// cli-tools.json is a trunk file; on a bare tree without it, skip. In an
// installed tree (trunk + this payload) it must carry the pinned
// opencode-ai entry.
describe.skipIf(!manifestPresent)('container/cli-tools.json opencode-ai CLI install', () => {
  it('includes the opencode-ai entry', () => {
    expect(opencode).toBeDefined();
  });

  it('pins it to an exact semver (no latest, no ranges)', () => {
    expect(opencode?.version).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  });
});
