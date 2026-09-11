import '../setup/providers/index.js';
import '../src/providers/index.js';
import '../src/provider-contracts/index.js';
import { listSetupProviders } from '../setup/providers/registry.js';
import { listProviderContainerConfigNames } from '../src/providers/provider-container-registry.js';
import { listProviderHostContractNames } from '../src/provider-contracts/registry.js';

console.log(
  JSON.stringify({
    host: listProviderHostContractNames().sort(),
    hostProviders: listProviderContainerConfigNames().sort(),
    setupProviders: listSetupProviders().map((provider) => provider.value).sort(),
  }),
);
