/**
 * Integration test for the opencode provider's CONTAINER-side reach-in: the self-registration
 * import in container/agent-runner/src/providers/index.ts. Importing the barrel runs
 * opencode.ts's top-level registerProvider('opencode', …); without that import line
 * createProvider('opencode') throws 'Unknown provider' at runtime.
 *
 * Behavior, not structural, and BARREL-ONLY: it imports the real barrel (./index.js),
 * never ./opencode.js directly, then asserts listProviderNames() contains the provider. The
 * existing opencode.factory.test.ts imports ./opencode.js directly, so it self-registers and
 * stays GREEN when the barrel line is deleted — a unit test, not a registration guard.
 * This goes red if the barrel import is deleted/drifts or the barrel fails to evaluate, or if @opencode-ai/sdk is not installed (the unmocked barrel import throws) — so it also implicitly guards that dependency.
 */
import { describe, it, expect } from 'bun:test';

import { listProviderNames } from './provider-registry.js';
import './index.js'; // the real container provider barrel — triggers each provider's registerProvider()

describe('opencode provider registration', () => {
  it('registers opencode via the provider barrel', () => {
    expect(listProviderNames()).toContain('opencode');
  });
});
