import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The agent's Node must meet the same minimum setup enforces on the host.
const here = dirname(fileURLToPath(import.meta.url));
const dockerfile = readFileSync(join(here, 'Dockerfile'), 'utf8');
const lib = join(here, '..', 'setup', 'lib', 'node-version.sh');

describe('container/Dockerfile base image', () => {
  const from = dockerfile.match(/^FROM node:(\S+)$/m);

  it('pins an exact Node release by digest', () => {
    expect(from?.[1]).toMatch(/^\d+\.\d+\.\d+-(?:[a-z]+-)?slim@sha256:[0-9a-f]{64}$/);
  });

  it('meets the Node minimum', () => {
    const version = from?.[1].split('-')[0] ?? '';
    const r = spawnSync('bash', ['-c', 'source "$1"; node_meets_minimum "$2"', '_', lib, version]);
    expect(r.status).toBe(0);
  });
});
