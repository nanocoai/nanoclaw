/**
 * Reusable runtime-contract conformance suite.
 *
 * Every provider — Claude and the test-double mock included — proves its
 * contract from its own `providers/<name>.conformance.test.ts`:
 *
 *   import './index.js';
 *   import { codexRuntimeContract } from '../provider-contracts/codex.js';
 *   import { defineProviderConformance } from '../provider-contracts/testing/conformance.js';
 *   defineProviderConformance('codex', codexRuntimeContract);
 *
 * Pass `options.probes` when the default probe fixtures cannot exercise a
 * function capability (for example an env-gated resolve, or an inference
 * resolve that ignores `model`). Probe fixtures are provider knowledge and a
 * test concern, so they travel with the provider's test file and never on the
 * production contract — which is why core runs no generic sweep over the
 * registered contracts: it could not know which fixtures a payload needs.
 * The install-time verifier requires the file for every declared provider.
 * Mirrors the host's `src/db/testing/driver-conformance.ts` pattern.
 */
import { describe, expect, it } from 'bun:test';

import { createProvider } from '../../providers/factory.js';
import { getProviderRuntimeContract } from '../../providers/provider-registry.js';
import type { ProviderRuntimeContract } from '../registry.js';
import {
  assertProviderRuntimeContractShape,
  probeProviderRuntimeConfiguration,
  type ProbeFixtures,
} from '../verifier.js';

export interface ProviderConformanceOptions {
  probes?: ProbeFixtures;
}

export function defineProviderConformance(
  name: string,
  contract: ProviderRuntimeContract,
  options: ProviderConformanceOptions = {},
): void {
  describe(`runtime provider contract: ${name}`, () => {
    it('is the contract registered for its provider', () => {
      expect(getProviderRuntimeContract(name)).toBe(contract);
    });

    it('matches its provider implementation', () => {
      expect(() => createProvider(name)).not.toThrow();
    });

    it('satisfies the contract shape', () => {
      expect(() => assertProviderRuntimeContractShape(name, contract)).not.toThrow();
    });

    it('has live configuration capabilities', () => {
      expect(() => probeProviderRuntimeConfiguration(name, contract, options.probes)).not.toThrow();
    });
  });
}
