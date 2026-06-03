import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getNetworkPolicyProvider,
  registerNetworkPolicyProvider,
  resetNetworkPolicyProviderForTests,
} from './index.js';

// The squid-policy-provider self-registers at module-import time. Other
// test files in this suite import it for unit tests of its pure helpers,
// which leaks the registration into shared module state. Reset both
// before and after every test in this file so the "no provider"
// assertions are deterministic regardless of test load order.
beforeEach(() => {
  resetNetworkPolicyProviderForTests();
});

afterEach(() => {
  resetNetworkPolicyProviderForTests();
});

describe('network policy registry', () => {
  it('returns undefined when no provider is registered', () => {
    expect(getNetworkPolicyProvider()).toBeUndefined();
  });

  it('returns the registered provider', () => {
    const provider = { ensure: async () => {} };
    registerNetworkPolicyProvider(provider);
    expect(getNetworkPolicyProvider()).toBe(provider);
  });

  it('throws on double-registration', () => {
    registerNetworkPolicyProvider({});
    expect(() => registerNetworkPolicyProvider({})).toThrow(/already registered/);
  });

  it('exposes optional hooks unchanged', async () => {
    let ensureCalls = 0;
    let applyCalls = 0;
    registerNetworkPolicyProvider({
      ensure: async () => {
        ensureCalls += 1;
      },
      applyContainerArgs: async () => {
        applyCalls += 1;
      },
    });
    const p = getNetworkPolicyProvider()!;
    await p.ensure?.();
    await p.applyContainerArgs?.([], {
      agentGroup: { id: 'g', name: 'g', folder: 'g', agent_provider: null, created_at: 'now' },
    });
    expect(ensureCalls).toBe(1);
    expect(applyCalls).toBe(1);
  });
});
