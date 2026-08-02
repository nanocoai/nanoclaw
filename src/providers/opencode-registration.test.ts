/**
 * Integration test for the opencode provider's HOST-side reach-in: the self-registration
 * import in the src/providers/index.ts barrel. Importing the barrel runs opencode.ts's
 * top-level registerProviderContainerConfig('opencode', …); without that import line the
 * host never wires the provider's per-session mounts / env passthrough.
 *
 * Behavior, not structural, and BARREL-ONLY: it imports the real barrel (./index.js),
 * never ./opencode.js directly, then asserts the registry actually contains the provider.
 * Importing the provider module directly (as opencode.factory.test.ts does) self-registers
 * it and would stay GREEN even if the barrel line were deleted — that is a unit test,
 * not a registration guard. This test goes red if the barrel import is deleted/drifts,
 * or the barrel fails to evaluate.
 *
 * A provider is a MULTI-POINT integration: this guards the HOST barrel; the CONTAINER
 * barrel is guarded by the sibling bun test; the SDK/CLI dependency + Dockerfile install
 * are guarded by the build/container legs (see the skill's validate step).
 */
import { describe, it, expect } from 'vitest';

import { listProviderContainerConfigNames } from './provider-container-registry.js';
import './index.js'; // the real host provider barrel — triggers each provider's self-registration

describe('opencode provider host registration', () => {
  it('registers opencode host container-config via the barrel', () => {
    expect(listProviderContainerConfigNames()).toContain('opencode');
  });
});
