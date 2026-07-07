/**
 * Structural guard for the mnemon entrypoint reach-in.
 *
 * container/entrypoint.sh runs on every container start; the inserted
 * `mnemon setup --target claude-code` line is what registers the Claude Code
 * memory hooks. The entrypoint is a shell script, not an invocable function, so
 * the guard is structural: assert the setup invocation is present. Drop it on an
 * upgrade and the hooks silently never register — this test goes red.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'vitest';

function entrypoint(): string {
  // From src/ up to repo root, then into container/.
  const p = path.resolve(__dirname, '..', 'container', 'entrypoint.sh');
  return fs.readFileSync(p, 'utf8');
}

describe('container/entrypoint.sh runs mnemon setup on start', () => {
  const text = entrypoint();

  it('invokes mnemon setup targeting claude-code', () => {
    expect(text).toMatch(/mnemon\s+setup\s+--target\s+claude-code/);
  });
});
