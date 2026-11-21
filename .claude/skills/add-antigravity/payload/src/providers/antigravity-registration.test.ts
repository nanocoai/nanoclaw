/**
 * Integration test for the antigravity provider's HOST-side reach-in: the
 * self-registration import in the src/providers/index.ts barrel.
 *
 * BARREL-ONLY: it imports the real barrel (./index.js), never
 * ./antigravity.js directly, so deleting the barrel line turns it red.
 */
import { describe, expect, it } from 'vitest';

import { listProviderContainerConfigNames, providerProvidesAgentSurfaces } from './provider-container-registry.js';
import './index.js';

describe('antigravity provider host registration', () => {
  it('registers the antigravity host container config via the barrel', () => {
    expect(listProviderContainerConfigNames()).toContain('antigravity');
  });

  it('declares that it owns its agent surfaces, so no Claude surfaces are mounted', () => {
    expect(providerProvidesAgentSurfaces('antigravity')).toBe(true);
  });
});
