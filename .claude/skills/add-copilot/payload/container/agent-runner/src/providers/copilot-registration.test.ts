import { describe, expect, it } from 'bun:test';

import './index.js';
import '../provider-contracts/index.js';
import { getProviderRuntimeContract, listProviderNames } from './provider-registry.js';

describe('Copilot provider registration', () => {
  it('registers with the shared provider and runtime-contract barrels', () => {
    expect(listProviderNames()).toContain('copilot');
    expect(getProviderRuntimeContract('copilot')?.textDelivery).toBe('mid-turn-complete');
  });
});
