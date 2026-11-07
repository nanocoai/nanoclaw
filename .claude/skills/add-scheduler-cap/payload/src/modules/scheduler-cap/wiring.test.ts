/**
 * Wiring: the modules barrel imports the cap, the cap registers into the
 * scheduler admission seam when the limit is set, and leaves the default
 * (admit everything) in place when it is not.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  getActiveContainerCount: vi.fn(() => 0),
  isContainerRunning: vi.fn(() => false),
  killContainer: vi.fn(),
}));

// Fresh module graph per test: the cap registers at import time, so the admission
// module must be imported after the reset to be the same instance the cap sees.
async function load() {
  const admission = await import('../scheduling/admission.js');
  await import('./index.js');
  return admission.hasCustomSchedulerAdmission();
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('scheduler cap wiring', () => {
  it('is imported by the modules barrel', () => {
    const barrel = fs.readFileSync(path.resolve(process.cwd(), 'src/modules/index.ts'), 'utf8');
    expect(barrel).toMatch(/^import '\.\/scheduler-cap\/index\.js';$/m);
  });

  it('registers an admission when the limit is set', async () => {
    vi.stubEnv('SCHEDULER_MAX_CONTAINERS', '2');
    expect(await load()).toBe(true);
  });

  it.each(['', '0', '-1', 'two', '1.5'])('keeps the default admission for %j', async (value) => {
    vi.stubEnv('SCHEDULER_MAX_CONTAINERS', value);
    expect(await load()).toBe(false);
  });
});
