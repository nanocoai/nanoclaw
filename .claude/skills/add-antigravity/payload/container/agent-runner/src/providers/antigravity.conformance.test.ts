/**
 * Runtime-contract conformance for the antigravity payload, run through the
 * core's own reusable suite (provider-contracts/testing/conformance.ts):
 * registered contract identity, factory construction, contract shape, and live
 * configuration probes.
 *
 * The suite exists only on the contract core. On a pre-contract install the
 * file is absent, so this skips there. The contract modules are loaded
 * dynamically for the same reason: a static import would fail to resolve where
 * the core does not carry them.
 */
import fs from 'fs';
import { describe, it } from 'bun:test';

const CONFORMANCE_SUITE = '../provider-contracts/testing/conformance.ts';
const hasContractCore = fs.existsSync(new URL(CONFORMANCE_SUITE, import.meta.url));

if (hasContractCore) {
  await import('./index.js');
  await import('../provider-contracts/index.js');
  const { antigravityRuntimeContract } = await import('../provider-contracts/antigravity.js');
  const { defineProviderConformance } = await import('../provider-contracts/testing/conformance.js');
  // The default fixtures suffice: inference answers `model`, memory answers
  // the hook command, and the MCP capability answers the server map.
  defineProviderConformance('antigravity', antigravityRuntimeContract);
} else {
  describe.skip('runtime provider contract: antigravity', () => {
    it('needs the contract core', () => {});
  });
}
