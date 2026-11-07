import { DEFAULT_PROJECT_DOC } from '../project-doc-compose.js';

import { PROVIDER_HOST_CONTRACT_SEAM_VERSION, registerProviderHostContract } from './registry.js';

/**
 * Host contract for the `pi` provider.
 *
 * Every declared surface lives inside the group's own subtree (the group
 * folder, or the group's session state), so each is classed `group-state`
 * rather than `allowlisted-extra`: the stricter class makes the driver check
 * the mount against this group's scope instead of admitting it unconditionally.
 *
 * pi reads the project document from `AGENTS.md` and discovers skills from
 * `.agents/skills` (global `~/.agents/skills`, `~/.pi/agent/skills`). The
 * group's pi state lives in a shared `.pi-shared` volume mounted at the
 * agentDir itself, so model config and gateway placeholders persist across
 * sessions. The volume is mounted at the agentDir (not `~/.pi`) because core's
 * spawn realization creates only the state volume root, and a prepared file
 * below it must not need an intermediate directory.
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
    mountClass: 'group-state',
    // Instruction prose is core-owned canon; pi declares only the facts
    // rendered into it.
    instructions: {
      nativeOverrideFiles: ['AGENTS.local.md', 'AGENTS.override.md'],
      nativeSkills: {
        discoveryPath: '/workspace/agent/.agents/skills',
        sharedSource: '/app/skills',
        selfAuthoredHome: '~/.pi/agent/skills',
        persistentRoots: ['~/.pi/agent', '~/.agents'],
        ruleBearingInlined: true,
      },
    },
  },
  stateVolumes: [
    {
      id: 'pi-home',
      directory: '.pi-shared',
      containerPath: '/home/node/.pi/agent',
      scope: 'group',
      mode: 'rw',
      mountClass: 'group-state',
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
      mountClass: 'group-state',
    },
    {
      backingId: 'pi-skills',
      containerPath: '/home/node/.agents',
      mode: 'ro',
      mountClass: 'group-state',
    },
  ],
  files: [
    {
      id: 'pi-auth-stub',
      volumeId: 'pi-home',
      relativePath: 'auth.json',
      prepare: { operation: 'append-open-close', when: 'every-spawn' },
    },
  ],
  legacyHostAdapter: 'required',
});
