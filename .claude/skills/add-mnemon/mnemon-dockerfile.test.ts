/**
 * Structural guard for the mnemon Dockerfile reach-in (the dependency install).
 *
 * mnemon ships as a GitHub-release binary, not an npm package, so it can't be
 * imported or typechecked. The only red-on-drift guard is asserting the install
 * layer is present in container/Dockerfile: drop the layer on an upgrade and the
 * container starts with "mnemon: command not found", but nothing else fails.
 * This test reads the Dockerfile and asserts the MNEMON_VERSION ARG and the
 * MNEMON_DATA_DIR ENV are both present.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'vitest';

function dockerfile(): string {
  // From src/ up to repo root, then into container/.
  const p = path.resolve(__dirname, '..', 'container', 'Dockerfile');
  return fs.readFileSync(p, 'utf8');
}

describe('container/Dockerfile installs the mnemon binary', () => {
  const text = dockerfile();

  it('declares the MNEMON_VERSION build arg', () => {
    expect(text).toMatch(/ARG\s+MNEMON_VERSION/);
  });

  it('downloads the mnemon release binary', () => {
    expect(text).toContain('mnemon-dev/mnemon/releases/download');
  });

  it('sets MNEMON_DATA_DIR into the .claude mount', () => {
    expect(text).toMatch(/ENV\s+MNEMON_DATA_DIR=/);
  });
});
