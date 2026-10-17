/**
 * Runtime-contract conformance for the codex payload, run through the core's
 * own reusable suite (provider-contracts/testing/conformance.ts): registered
 * contract identity, factory construction, contract shape, and live
 * configuration probes.
 *
 * The suite exists only on the contract core. On the standalone providers
 * branch and on a pre-contract install the file is absent, so this skips
 * there — the same core detection codex-contract-parity.test.ts uses. The
 * contract modules are loaded dynamically for the same reason: a static
 * import would fail to resolve where the core does not carry them.
 */
import fs from 'fs';
import { describe, it } from 'bun:test';

const CONFORMANCE_SUITE = '../provider-contracts/testing/conformance.ts';
const hasContractCore = fs.existsSync(new URL(CONFORMANCE_SUITE, import.meta.url));

if (hasContractCore) {
  await import('./index.js');
  await import('../provider-contracts/index.js');
  const { codexRuntimeContract } = await import('../provider-contracts/codex.js');
  const { defineProviderConformance } = await import('../provider-contracts/testing/conformance.js');
  defineProviderConformance('codex', codexRuntimeContract);
} else {
  describe.skip('runtime provider contract: codex', () => {
    it('needs the contract core', () => {});
  });
}
