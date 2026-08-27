/**
 * Runtime-contract conformance for the opencode payload, run through the
 * core's own reusable suite (provider-contracts/testing/conformance.ts):
 * registered contract identity, factory construction, contract shape, and
 * live configuration probes.
 *
 * The suite exists only on the contract core. On the standalone providers
 * branch and on a pre-contract install the file is absent, so this skips
 * there. The contract modules are loaded dynamically for the same reason: a
 * static import would fail to resolve where the core does not carry them.
 */
import fs from 'fs';
import { describe, it } from 'bun:test';

const CONFORMANCE_SUITE = '../provider-contracts/testing/conformance.ts';
const hasContractCore = fs.existsSync(new URL(CONFORMANCE_SUITE, import.meta.url));

if (hasContractCore) {
  await import('./index.js');
  await import('../provider-contracts/index.js');
  const { opencodeRuntimeContract } = await import('../provider-contracts/opencode.js');
  const { defineProviderConformance } = await import('../provider-contracts/testing/conformance.js');
  defineProviderConformance('opencode', opencodeRuntimeContract, {
    probes: {
      // OpenCode selects its model through the OPENCODE_* environment the host
      // provisions, so the suite's default probes (which vary `model` alone)
      // cannot exercise the inference capability. Only `effort` responds to
      // the core input, and only for a model the emitted config registers
      // itself (any provider but `anthropic`), so probe under that environment.
      inference: {
        a: { effort: 'low' },
        b: { effort: 'high' },
        environment: { OPENCODE_PROVIDER: 'openai', OPENCODE_MODEL: 'openai/nanoclaw-probe-model' },
      },
    },
  });
} else {
  describe.skip('runtime provider contract: opencode', () => {
    it('needs the contract core', () => {});
  });
}
