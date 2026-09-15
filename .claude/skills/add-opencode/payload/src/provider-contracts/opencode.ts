import { CLAUDE_COMPATIBLE_HOST_SURFACES } from './claude.js';
import { registerProviderHostContract } from './registry.js';

registerProviderHostContract('opencode', {
  seamVersion: 1,
  legacyHostAdapter: 'required',
  ...CLAUDE_COMPATIBLE_HOST_SURFACES,
  stateVolumes: [
    ...CLAUDE_COMPATIBLE_HOST_SURFACES.stateVolumes,
    {
      id: 'opencode-xdg',
      directory: 'opencode-xdg',
      containerPath: '/opencode-xdg',
      scope: 'session',
      mode: 'rw',
      mountClass: 'allowlisted-extra',
    },
  ],
  commands: { nativeAdmin: [], nativeFiltered: [] },
});
