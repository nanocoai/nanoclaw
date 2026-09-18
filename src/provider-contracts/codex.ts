import { CODEX_PROJECT_DOC_MAX_BYTES } from '../providers/codex-agents-md.js';

import { registerProviderHostContract } from './registry.js';

const HOST_SEAM_VERSION = 1;

registerProviderHostContract('codex', {
  seamVersion: HOST_SEAM_VERSION,
  projectDocument: {
    fileName: 'AGENTS.md',
    maxBytes: CODEX_PROJECT_DOC_MAX_BYTES,
    containerPath: '/workspace/agent/AGENTS.md',
    mountClass: 'allowlisted-extra',
    // Instruction prose is core-owned canon; Codex declares only the facts
    // rendered into it.
    instructions: {
      nativeOverrideFiles: ['AGENTS.local.md', 'AGENTS.override.md'],
      nativeSkills: {
        discoveryPath: '/workspace/agent/.agents/skills',
        sharedSource: '/app/skills',
        selfAuthoredHome: '~/.codex/skills',
        persistentRoots: ['~/.codex', '~/.agents'],
        ruleBearingInlined: true,
      },
    },
  },
  stateVolumes: [
    {
      id: 'codex-home',
      directory: '.codex-shared',
      containerPath: '/home/node/.codex',
      scope: 'group',
      mode: 'rw',
      mountClass: 'allowlisted-extra',
    },
  ],
  skillBackings: [
    {
      id: 'codex-skills',
      location: { kind: 'group-directory', directory: '.agents', subdirectory: '' },
      skillsSubdirectory: 'skills',
      conflictDiagnostics: 'silent',
      templateCopies: 'copy',
    },
  ],
  skillViews: [
    {
      backingId: 'codex-skills',
      containerPath: '/workspace/agent/.agents',
      mode: 'ro',
      mountClass: 'allowlisted-extra',
    },
    {
      backingId: 'codex-skills',
      containerPath: '/home/node/.agents',
      mode: 'ro',
      mountClass: 'allowlisted-extra',
    },
  ],
  files: [
    {
      id: 'codex-auth-stub',
      volumeId: 'codex-home',
      relativePath: 'auth.json',
      prepare: { operation: 'append-open-close', when: 'every-spawn' },
    },
  ],
  // Core validates `--speed` against these names; the runtime payload renders
  // only `fast` (as `service_tier = "fast"`), `standard` keeps Codex's default.
  inference: { speedTiers: ['standard', 'fast'] },
  legacyHostAdapter: 'required',
});
