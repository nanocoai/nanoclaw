import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Guards system packages the agent's own tools shell out to. Dropping one still
// builds; it only fails at runtime, inside the container, on a user's message.
const here = dirname(fileURLToPath(import.meta.url));
// Comment lines are dropped first: Docker skips them even inside a RUN.
const dockerfile = readFileSync(join(here, 'Dockerfile'), 'utf8').replace(/^\s*#.*$/gm, '');

function baseAptPackages(): string[] {
  const block = dockerfile.match(/apt-get install -y --no-install-recommends([^&]*)&&/);
  if (!block) throw new Error('base apt-get install list not found in container/Dockerfile');
  return block[1].split(/[\s\\]+/).filter(Boolean);
}

describe('container/Dockerfile system packages', () => {
  it('installs poppler-utils (pdftoppm), which Claude Code needs to read a PDF', () => {
    expect(baseAptPackages()).toContain('poppler-utils');
  });
});
