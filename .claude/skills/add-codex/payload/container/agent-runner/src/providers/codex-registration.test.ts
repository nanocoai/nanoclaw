/**
 * Integration test for the codex provider's CONTAINER-side reach-in: the self-registration
 * import in container/agent-runner/src/providers/index.ts. Importing the barrel runs
 * codex.ts's top-level registerProvider('codex', …); without that import line
 * createProvider('codex') throws 'Unknown provider' at runtime.
 *
 * Behavior, not structural, and BARREL-ONLY: it imports the real barrel (./index.js),
 * never ./codex.js directly, then asserts listProviderNames() contains the provider. The
 * existing codex.factory.test.ts imports ./codex.js directly, so it self-registers and
 * stays GREEN when the barrel line is deleted — a unit test, not a registration guard.
 * This goes red if the barrel import is deleted/drifts or the barrel fails to evaluate. codex uses the @openai/codex CLI *binary* (not an importable package), so this test does not guard that dependency — the Dockerfile install line is guarded structurally + by the container build (see the skill validate step).
 */
import { describe, it, expect } from 'bun:test';

import { listProviderNames } from './provider-registry.js';
import './index.js'; // the real container provider barrel — triggers each provider's registerProvider()

describe('codex provider registration', () => {
  it('registers codex via the provider barrel', () => {
    expect(listProviderNames()).toContain('codex');
  });
});
