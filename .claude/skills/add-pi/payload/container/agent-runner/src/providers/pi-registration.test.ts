/**
 * Integration test for the pi provider's CONTAINER-side reach-in: the self-registration
 * import in container/agent-runner/src/providers/index.ts. Importing the barrel runs
 * pi.ts's top-level registerProvider('pi', …); without that import line
 * createProvider('pi') throws 'Unknown provider' at runtime.
 *
 * Behavior, not structural, and BARREL-ONLY: it imports the real barrel (./index.js),
 * never ./pi.js directly, then asserts listProviderNames() contains the provider.
 * Goes red if the barrel import is deleted/drifts, the barrel fails to evaluate, or
 * @earendil-works/pi-coding-agent is not installed (the unmocked barrel import throws) —
 * so it also implicitly guards that dependency.
 */
import { describe, it, expect } from 'bun:test';

import { listProviderNames } from './provider-registry.js';
import './index.js'; // the real container provider barrel — triggers each provider's registerProvider()

describe('pi provider registration', () => {
  it('registers pi via the provider barrel', () => {
    expect(listProviderNames()).toContain('pi');
  });
});
