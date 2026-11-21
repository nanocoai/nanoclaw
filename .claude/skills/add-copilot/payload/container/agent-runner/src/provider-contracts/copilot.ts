import { registerProviderContract } from '../providers/provider-registry.js';
import type { ProviderRuntimeContract } from './registry.js';

export const copilotRuntimeContract: ProviderRuntimeContract = {
  seamVersion: 1,
  configuration: {
    executionPolicy: { constant: { boundary: 'container' } },
  },
  textDelivery: 'mid-turn-complete',
  commands: { formatting: 'xml' },
};

registerProviderContract('copilot', copilotRuntimeContract);
