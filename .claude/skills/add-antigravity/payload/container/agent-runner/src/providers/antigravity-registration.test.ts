/**
 * Integration test for the antigravity provider's CONTAINER-side reach-in: the
 * self-registration import in container/agent-runner/src/providers/index.ts.
 * Importing the barrel runs antigravity.ts's top-level
 * registerProvider('antigravity', …); without that import line
 * createProvider('antigravity') throws 'Unknown provider' at runtime.
 *
 * Behavior, not structural, and BARREL-ONLY: it imports the real barrel
 * (./index.js), never ./antigravity.js directly. Importing the provider module
 * directly (as the factory and turns tests do) self-registers it and would stay
 * GREEN even if the barrel line were deleted. agy is a native binary installed
 * by the Dockerfile block, not an importable package, so this test does not
 * guard it — the host-side Dockerfile test and the image build do.
 */
import { describe, it, expect } from 'bun:test';

import { listProviderNames } from './provider-registry.js';
import './index.js'; // the real container provider barrel — triggers each provider's registerProvider()

describe('antigravity provider registration', () => {
  it('registers antigravity via the provider barrel', () => {
    expect(listProviderNames()).toContain('antigravity');
  });
});
