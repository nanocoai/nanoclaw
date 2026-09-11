import { describe, expect, it } from 'vitest';

import '../providers/index.js';
import './index.js';
import {
  assertProviderHostConformance,
  assertProviderHostContractShape,
  getProviderHostContract,
  listProviderHostContractNames,
  registerProviderHostContract,
  type ProviderHostContract,
} from './registry.js';

/** Deep clone that carries contract functions (transforms) by reference. */
function cloneContract<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => cloneContract(entry)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneContract(entry)])) as T;
  }
  return value;
}

describe('installed host provider contracts', () => {
  it('match their compatibility adapters', () => {
    for (const name of listProviderHostContractNames()) {
      assertProviderHostContractShape(name, getProviderHostContract(name)!);
    }
    expect(() => assertProviderHostConformance()).not.toThrow();
  });

  it('rejects a declared provider whose required host adapter is missing', () => {
    const contract: ProviderHostContract = {
      ...cloneContract(getProviderHostContract('claude')!),
      legacyHostAdapter: 'required',
    };
    registerProviderHostContract('missing-startup-adapter', contract);

    expect(() => assertProviderHostConformance()).toThrow(
      "Provider 'missing-startup-adapter' host contract requires a legacy host adapter",
    );
  });
});
