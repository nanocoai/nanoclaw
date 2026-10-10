import '../providers/index.js';
import './index.js';
import { listProviderNames, listProviderRuntimeContractNames } from '../providers/provider-registry.js';

/** Lists registered providers and contracts. Prints only when run directly (`bun src/provider-contracts/names.ts`). */
export function providerRuntimeNames(): { contracts: string[]; providers: string[] } {
  return {
    contracts: listProviderRuntimeContractNames().sort(),
    providers: listProviderNames().sort(),
  };
}

if (import.meta.main) {
  console.log(JSON.stringify(providerRuntimeNames()));
}
