import { describe, it, expect } from 'bun:test';
import './index.js';
import { listProviderNames } from './provider-registry.js';

// `bun test --isolate` keeps sibling tests' direct provider imports out of this registry.
describe('opencode provider registration', () => {
  it('registers opencode via the provider barrel', () => {
    expect(listProviderNames()).toContain('opencode');
  });
});
