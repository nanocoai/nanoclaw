/**
 * Integration test for the opencode provider's CONTAINER-side reach-in: the self-registration
 * import in container/agent-runner/src/providers/index.ts. Importing the barrel runs
 * opencode.ts's top-level registerProvider('opencode', …); without that import line
 * createProvider('opencode') throws 'Unknown provider' at runtime.
 *
 * Behavior, not structural, and BARREL-ONLY: a fresh process imports the real barrel,
 * never ./opencode.js directly, then asserts listProviderNames() contains the provider.
 * Bun shares module state across test files, so sibling tests that import the provider
 * directly must not be able to satisfy this assertion when its barrel line is missing.
 * This goes red if the barrel import is deleted/drifts or the barrel fails to evaluate, or if @opencode-ai/sdk is not installed (the unmocked barrel import throws) — so it also implicitly guards that dependency.
 */
import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';

describe('opencode provider registration', () => {
  it('registers opencode via the provider barrel', () => {
    const probe = spawnSync(
      process.execPath,
      [
        '--eval',
        `import './index.ts';
         import { listProviderNames } from './provider-registry.ts';
         console.log(JSON.stringify(listProviderNames()));`,
      ],
      { cwd: import.meta.dir, encoding: 'utf8', timeout: 30_000 },
    );
    expect(probe.error).toBeUndefined();
    expect(probe.status, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout)).toContain('opencode');
  });
});
