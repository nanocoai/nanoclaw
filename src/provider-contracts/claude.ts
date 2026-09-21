import { DEFAULT_PROJECT_DOC } from '../project-doc-compose.js';
import { CLAUDE_DEFAULT_SETTINGS, claudeSettingsTransformer } from '../migrate-claude-memory-settings.js';

import { registerProviderFileTransformer } from './file-transformers.js';
import {
  PROVIDER_HOST_CONTRACT_SEAM_VERSION,
  registerProviderHostContract,
  type ProviderHostContract,
} from './registry.js';

export const CLAUDE_COMPATIBLE_HOST_SURFACES = {
  projectDocument: {
    fileName: DEFAULT_PROJECT_DOC.fileName,
    maxBytes: DEFAULT_PROJECT_DOC.maxBytes,
    containerPath: '/workspace/agent/CLAUDE.md',
    mountClass: 'group-state',
  },
  stateVolumes: [
    {
      id: 'claude-home',
      directory: '.claude-shared',
      containerPath: '/home/node/.claude',
      scope: 'group',
      mode: 'rw',
      mountClass: 'group-state',
    },
  ],
  skillBackings: [
    {
      id: 'claude-skills',
      location: { kind: 'state-volume', volumeId: 'claude-home', subdirectory: '' },
      skillsSubdirectory: 'skills',
      conflictDiagnostics: 'warn',
      templateCopies: 'in-place',
    },
  ],
  // The skills directory is already visible through the claude-home volume at
  // /home/node/.claude/skills, so no separate view mount is declared.
  skillViews: [],
  files: [
    {
      id: 'claude-settings',
      volumeId: 'claude-home',
      relativePath: 'settings.json',
      prepare: {
        operation: 'create-if-missing',
        when: 'group-init',
        content: CLAUDE_DEFAULT_SETTINGS,
      },
      reconcile: { transformer: 'claude-settings' },
    },
  ],
} satisfies Pick<ProviderHostContract, 'projectDocument' | 'stateVolumes' | 'skillBackings' | 'skillViews' | 'files'>;

// The payload owns its transformer: core names no provider's implementation.
registerProviderFileTransformer('claude-settings', claudeSettingsTransformer);

registerProviderHostContract('claude', {
  seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
  ...CLAUDE_COMPATIBLE_HOST_SURFACES,
  commands: {
    nativeAdmin: ['/compact', '/context', '/cost', '/files'],
    nativeFiltered: ['/start', '/help', '/login', '/logout', '/doctor', '/config', '/remote-control'],
  },
  // `fast` maps onto the SDK's fast serving tier; `standard` lets a group
  // explicitly override an install-wide NANOCLAW_FAST_MODE=true.
  inference: { speedTiers: ['standard', 'fast'] },
});
