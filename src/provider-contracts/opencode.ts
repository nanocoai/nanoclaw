import { CLAUDE_COMPATIBLE_HOST_SURFACES } from './claude.js';
import { registerProviderHostContract } from './registry.js';

const HOST_SEAM_VERSION = 1;

registerProviderHostContract('opencode', {
  seamVersion: HOST_SEAM_VERSION,
  ...CLAUDE_COMPATIBLE_HOST_SURFACES,
  legacyHostAdapter: 'required',
});
