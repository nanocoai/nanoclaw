import { CLAUDE_COMPATIBLE_HOST_SURFACES } from './claude.js';
import { registerProviderHostContract, PROVIDER_HOST_CONTRACT_SEAM_VERSION } from './registry.js';

registerProviderHostContract('copilot', {
  seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
  ...CLAUDE_COMPATIBLE_HOST_SURFACES,
  stateVolumes: CLAUDE_COMPATIBLE_HOST_SURFACES.stateVolumes.map((volume) => ({
    ...volume,
    directory: '.copilot-shared',
  })),
  // api.github.com is excluded: model domains are auto-approved host-wide, and the
  // device-login token is only scoped to /copilot_internal/* there.
  modelDomains: [
    'api.githubcopilot.com',
    'api.individual.githubcopilot.com',
    'api.business.githubcopilot.com',
    'api.enterprise.githubcopilot.com',
    'copilot-proxy.githubusercontent.com',
  ],
  commands: { nativeAdmin: [], nativeFiltered: [] },
});
