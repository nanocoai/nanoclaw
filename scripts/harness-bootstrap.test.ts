/**
 * Guard for the in-tree E2E harnesses.
 *
 * All four broke at once when the mailbox seam landed, and nothing noticed for
 * a release: they are scripts, so no build, typecheck or test leg touches them.
 * These assertions are the cheapest thing that goes red on the same class of
 * break — a harness that stops composing the host, or drifts back onto a
 * hard-coded image tag.
 *
 * They are structural on purpose. Running a harness needs Docker and a built
 * image, which a unit suite must not require; what can be checked here is that
 * each one still wires itself to the seams it depends on.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(path.join(here, name), 'utf8');

// Harnesses that drive the real host path, and so need the composition slots
// filled before they resolve a session.
const HOST_HARNESSES = ['test-v2-host.ts', 'test-v2-channel-e2e.ts'];

describe('host E2E harnesses', () => {
  for (const name of HOST_HARNESSES) {
    it(`${name} imports the composition bootstrap`, () => {
      const source = read(name);
      expect(
        source,
        `${name} must import './harness-bootstrap.js' or it dies on "No agent mailbox registered"`,
      ).toMatch(/import '\.\/harness-bootstrap\.js';/);
    });

    it(`${name} scaffolds the container_configs row via initGroupFilesystem`, () => {
      // Creating the agent group row alone is not enough: spawn calls
      // materializeContainerJson, which throws "Container config not found for
      // agent group" without the config row.
      const source = read(name);
      expect(source).toMatch(/initGroupFilesystem\(/);
    });
  }

  it('the bootstrap fills the mailbox slot through the real modules barrel', () => {
    // Importing src/mailbox/compose.js directly would work today and drift
    // tomorrow — the barrel is what src/index.ts imports.
    expect(read('harness-bootstrap.ts')).toMatch(/import '\.\.\/src\/modules\/index\.js';/);
  });

  it('the offline gateway is registered only from scripts/, never from src/', () => {
    // If src/ ever imported this, a stray NANOCLAW_GATEWAY_PROVIDER could make
    // the real host spawn agents with no credentials.
    const gateway = read('harness-gateway-noop.ts');
    expect(gateway).toMatch(/registerGatewayProvider\('harness-noop'|HARNESS_NOOP_GATEWAY_KIND/);
    expect(read('harness-bootstrap.ts')).toMatch(/import '\.\/harness-gateway-noop\.js';/);
  });
});

describe('container-side harness', () => {
  it('test-v2-agent.ts fills the container mailbox slot', () => {
    expect(read('test-v2-agent.ts')).toMatch(/import '\.\.\/container\/agent-runner\/src\/modules\/index\.js';/);
  });
});

describe('sanity-live-poll.ts', () => {
  const source = read('sanity-live-poll.ts');

  it('resolves the agent image per install instead of hard-coding a tag', () => {
    // `nanoclaw-agent:latest` has not been a real tag since image names became
    // per-checkout; the hard-coded name made every run silently vacuous.
    expect(source).not.toMatch(/nanoclaw-agent:latest/);
    expect(source).toMatch(/CONTAINER_IMAGE/);
  });

  it('fails loudly when the container reader misses host writes', () => {
    // The whole point is to detect a cross-mount visibility regression; a
    // version that only prints is not a regression test.
    expect(source).toMatch(/process\.exit\(1\)/);
  });
});
