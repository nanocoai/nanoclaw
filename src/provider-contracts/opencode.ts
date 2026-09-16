import { CLAUDE_COMPATIBLE_HOST_SURFACES } from './claude.js';
import { registerProviderHostContract } from './registry.js';

// Pinned literal, not the core's constant: a core seam bump must fail this
// payload's version check until the payload is refreshed to match.
const HOST_SEAM_VERSION = 1;

// OpenCode reads the Claude document plane exactly as the legacy path mounted
// it: the composed CLAUDE.md (canonical instructions, no provider facts), the
// group's .claude-shared home with its skills and settings.json, all under the
// same container paths.
registerProviderHostContract('opencode', {
  seamVersion: HOST_SEAM_VERSION,
  projectDocument: CLAUDE_COMPATIBLE_HOST_SURFACES.projectDocument,
  stateVolumes: [
    ...CLAUDE_COMPATIBLE_HOST_SURFACES.stateVolumes,
    // `opencode serve` keeps its state under XDG_DATA_HOME, pinned by the
    // legacy adapter's env to /opencode-xdg — the per-session directory the
    // adapter used to mkdir and mount itself.
    {
      id: 'opencode-xdg',
      directory: 'opencode-xdg',
      containerPath: '/opencode-xdg',
      scope: 'session',
      mode: 'rw',
      mountClass: 'allowlisted-extra',
    },
  ],
  skillBackings: CLAUDE_COMPATIBLE_HOST_SURFACES.skillBackings,
  skillViews: CLAUDE_COMPATIBLE_HOST_SURFACES.skillViews,
  // The inherited settings.json is Claude's file, so its reconciliation keeps
  // reporting as Claude settings — the same log line the legacy path wrote.
  files: CLAUDE_COMPATIBLE_HOST_SURFACES.files.map((file) => ({
    ...file,
    ...(file.reconcile === undefined ? {} : { reconcile: { ...file.reconcile, transformerProvider: 'claude' } }),
  })),
  // The adapter in src/providers/opencode.ts still contributes the env
  // (XDG_DATA_HOME, NO_PROXY, the OPENCODE_* passthrough); core realizes the
  // volume above and tells the adapter so through coreOwnsProviderSurfaces.
  legacyHostAdapter: 'required',
});
