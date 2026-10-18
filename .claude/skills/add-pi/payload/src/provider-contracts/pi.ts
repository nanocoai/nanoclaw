import { DEFAULT_PROJECT_DOC } from '../project-doc-compose.js';

import { PROVIDER_HOST_CONTRACT_SEAM_VERSION, registerProviderHostContract } from './registry.js';

/**
 * Host contract for the `pi` provider.
 *
 * pi reads the project document from `AGENTS.md` and discovers skills from
 * `.agents/skills` (global `~/.agents/skills`, `~/.pi/agent/skills`). The
 * group's pi state lives in a shared `.pi-shared` volume so model config and
 * gateway placeholders persist across sessions.
 *
 * Credentials are gateway-owned: `auth.json` is prepared empty at every spawn
 * and the container fills it with non-secret `gateway-managed` placeholders.
 * The `openai-codex` (ChatGPT) and API-key destinations below are the hosts
 * the selected gateway is allowed to inject into.
 */
registerProviderHostContract('pi', {
  modelEndpoints: {
    api: 'https://api.openai.com',
    subscription: 'https://chatgpt.com',
    token: 'https://auth.openai.com/oauth/token',
  },
  modelDomains: [
    'openai.com',
    'chatgpt.com',
    'anthropic.com',
    'openrouter.ai',
    'deepseek.com',
    'generativelanguage.googleapis.com',
  ],
  seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
  projectDocument: {
    fileName: 'AGENTS.md',
    maxBytes: DEFAULT_PROJECT_DOC.maxBytes,
    containerPath: '/workspace/agent/AGENTS.md',
    mountClass: 'allowlisted-extra',
    // Instruction prose is core-owned canon; pi declares only the facts
    // rendered into it.
    instructions: {
      nativeOverrideFiles: ['AGENTS.local.md', 'AGENTS.override.md'],
      nativeSkills: {
        discoveryPath: '/workspace/agent/.agents/skills',
        sharedSource: '/app/skills',
        selfAuthoredHome: '~/.pi/agent/skills',
        persistentRoots: ['~/.pi', '~/.agents'],
        ruleBearingInlined: true,
      },
    },
  },
  stateVolumes: [
    {
      id: 'pi-home',
      directory: '.pi-shared',
      containerPath: '/home/node/.pi',
      scope: 'group',
      mode: 'rw',
      mountClass: 'allowlisted-extra',
    },
  ],
  skillBackings: [
    {
      id: 'pi-skills',
      location: { kind: 'group-directory', directory: '.agents', subdirectory: '' },
      skillsSubdirectory: 'skills',
      conflictDiagnostics: 'silent',
      templateCopies: 'copy',
    },
  ],
  skillViews: [
    {
      backingId: 'pi-skills',
      containerPath: '/workspace/agent/.agents',
      mode: 'ro',
      mountClass: 'allowlisted-extra',
    },
    {
      backingId: 'pi-skills',
      containerPath: '/home/node/.agents',
      mode: 'ro',
      mountClass: 'allowlisted-extra',
    },
  ],
  files: [
    {
      id: 'pi-auth-stub',
      volumeId: 'pi-home',
      relativePath: 'agent/auth.json',
      prepare: { operation: 'append-open-close', when: 'every-spawn' },
    },
  ],
  legacyHostAdapter: 'required',
});
