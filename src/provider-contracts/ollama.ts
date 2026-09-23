import { BLOCKED_CLOUD_HOSTS } from '../providers/ollama.js';

import { CLAUDE_COMPATIBLE_HOST_SURFACES } from './claude.js';
import { registerProviderHostContract } from './registry.js';

// Pinned literal, not the core's constant: a core seam bump must fail this
// payload's version check until the payload is refreshed to match.
const HOST_SEAM_VERSION = 1;

// Ollama drives the Claude Agent SDK against the local daemon, so its
// agent-facing surfaces are Claude's: the same project document, state volume
// and settings.json hook file. A group switching between the two providers
// keeps its memory and its skills.
//
// No `commands`: the host gate unions every contract's, and Claude's is always
// registered, so a second copy of the same Claude Code list could only drift.
// No `inference`: the local daemon serves one tier, so `--speed` is rejected.
registerProviderHostContract('ollama', {
  seamVersion: HOST_SEAM_VERSION,
  ...CLAUDE_COMPATIBLE_HOST_SURFACES,
  // Core carries only a contract's blocked hosts onto the spawn, so the cloud
  // endpoints the group must not reach are declared here. The daemon routing
  // env still comes from the container-config adapter (src/providers/ollama.ts);
  // a host without it must not spawn an Ollama group.
  blockedHosts: BLOCKED_CLOUD_HOSTS,
  legacyHostAdapter: 'required',
});
