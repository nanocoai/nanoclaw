/**
 * Dependency guard for the OpenCode CLI integration point (host tree, vitest).
 *
 * add-opencode installs the `opencode-ai` CLI globally in the agent container
 * image via `container/Dockerfile`. A globally-installed CLI binary is not
 * importable or typed, so neither `tsc` nor a runtime import can catch its
 * removal — only the container image build would, and the skill's validate step
 * does not rebuild the image in CI. This structural test stands in for that
 * build leg: it parses the Dockerfile and asserts both halves of the install are
 * present — the pinned `ARG OPENCODE_VERSION=...` and the
 * `pnpm install -g "opencode-ai@${OPENCODE_VERSION}"` line. Drop or drift either
 * and this goes red.
 *
 * Pinning matters here beyond reproducibility: the `opencode-ai` CLI version
 * must match the `@opencode-ai/sdk` version the container provider imports. An
 * unpinned `latest` would silently upgrade the CLI past the SDK's compatible
 * range and break sessions. The test therefore also rejects `@latest`.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'vitest';

function dockerfile(): string {
  // Walk up from this test file to the repo root (the dir holding container/Dockerfile),
  // so the test works wherever it is copied (src/ on the host, or the skill folder).
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'container', 'Dockerfile');
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8');
    dir = path.dirname(dir);
  }
  throw new Error('container/Dockerfile not found walking up from ' + __dirname);
}

describe('container/Dockerfile installs the OpenCode CLI', () => {
  const text = dockerfile();

  it('declares a pinned OPENCODE_VERSION build arg (not latest)', () => {
    expect(text).toMatch(/^ARG\s+OPENCODE_VERSION=\S+/m);
    expect(text).not.toMatch(/^ARG\s+OPENCODE_VERSION=latest\s*$/m);
  });

  it('globally installs the pinned opencode-ai package via pnpm', () => {
    expect(text).toMatch(/pnpm install -g\s+"?opencode-ai@\$\{OPENCODE_VERSION\}"?/);
  });
});
