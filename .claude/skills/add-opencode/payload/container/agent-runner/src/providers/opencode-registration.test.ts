import { describe, it, expect } from 'bun:test';
import './index.js';
import '../provider-contracts/index.js';
import { getProviderRuntimeContract, listProviderNames } from './provider-registry.js';

// `bun test --isolate` keeps sibling tests' direct provider imports out of this registry.
describe('opencode provider registration', () => {
  it('declares the runtime seam implemented by this installed payload', () => {
    expect(getProviderRuntimeContract('opencode')?.seamVersion).toBe(1);
  });
  it('registers opencode via the provider barrel', () => {
    expect(listProviderNames()).toContain('opencode');
  });
});
