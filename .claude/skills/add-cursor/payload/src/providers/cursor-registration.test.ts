/**
 * Integration test for the cursor provider's HOST-side reach-in: the
 * self-registration import in the src/providers/index.ts barrel. Importing
 * the barrel runs cursor.ts's top-level registerProviderContainerConfig.
 *
 * Behavior, not structural, and BARREL-ONLY: it imports the real barrel
 * (./index.js), never ./cursor.js directly.
 */
import { describe, it, expect } from 'vitest';

import { listProviderContainerConfigNames } from './provider-container-registry.js';
import './index.js';

describe('cursor provider host registration', () => {
  it('registers cursor host container-config via the barrel', () => {
    expect(listProviderContainerConfigNames()).toContain('cursor');
  });
});
