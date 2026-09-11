import { registerProviderContract } from '../providers/provider-registry.js';
import { PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION, type ProviderRuntimeContract } from './registry.js';

/**
 * Runtime contract for the test-double provider (providers/mock.ts). It goes
 * through the same two-step registration as every real provider, proves its
 * contract from providers/mock.conformance.test.ts like every other provider,
 * and the poll-loop sees the mock the way it sees Claude.
 *
 * The mock streams every text segment before the turn's result (mirroring the
 * SDK's assistant-message -> result ordering), so it declares mid-turn
 * delivery. It formats commands as XML and has no inference, memory, or MCP
 * surface, so those capabilities are omitted.
 */
export const mockRuntimeContract: ProviderRuntimeContract = {
  seamVersion: PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION,
  configuration: {
    // Nothing runs: the mock never leaves the process.
    executionPolicy: { constant: { sandbox: 'none' } },
  },
  textDelivery: 'mid-turn-complete',
  commands: { formatting: 'xml' },
};

registerProviderContract('mock', mockRuntimeContract);
