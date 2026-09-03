import { registerProviderHostContract } from './registry.js';

// Pinned literal, not the core's constant: a core seam bump must fail this
// payload's version check until the payload is refreshed to match.
const HOST_SEAM_VERSION = 1;

// Every surface below is the one the pre-contract adapter (src/providers/cursor.ts)
// used to build by hand, declared instead: same state directory name, same
// container paths, same modes, same late (allowlisted-extra) mount slot.
registerProviderHostContract('cursor', {
  seamVersion: HOST_SEAM_VERSION,
  projectDocument: {
    fileName: 'AGENTS.md',
    containerPath: '/workspace/agent/AGENTS.md',
    mountClass: 'allowlisted-extra',
    // Instruction prose is core-owned canon; Cursor declares only the facts
    // rendered into it. Cursor publishes no hard project-document byte cap,
    // so no maxBytes: the document is never truncated for it.
    instructions: {
      // Files Cursor's local rules service auto-loads from the workspace root
      // alongside AGENTS.md (@cursor/sdk 1.0.28, LocalCursorRulesService), so
      // memory must never be written into them.
      nativeOverrideFiles: ['.cursorrules', 'CLAUDE.md', 'CLAUDE.local.md'],
      nativeSkills: {
        discoveryPath: '/workspace/agent/.cursor/skills',
        sharedSource: '/app/skills',
        selfAuthoredHome: '~/.cursor/skills',
        persistentRoots: ['~/.cursor'],
        ruleBearingInlined: true,
      },
    },
  },
  stateVolumes: [
    {
      // The SDK's local agent store, hooks.json and self-authored skills:
      // per group, persistent across sessions so continuations survive respawns.
      id: 'cursor-home',
      directory: '.cursor-shared',
      containerPath: '/home/node/.cursor',
      scope: 'group',
      mode: 'rw',
      mountClass: 'allowlisted-extra',
    },
  ],
  skillBackings: [
    // Cursor discovers skills at `<workspace>/.cursor/skills` and
    // `~/.cursor/skills`; the agent workspace is not a git repo, so both
    // layers carry the same selection.
    {
      id: 'cursor-project-skills',
      location: { kind: 'group-directory', directory: '.cursor', subdirectory: '' },
      skillsSubdirectory: 'skills',
      conflictDiagnostics: 'silent',
      templateCopies: 'copy',
    },
    {
      id: 'cursor-home-skills',
      location: { kind: 'state-volume', volumeId: 'cursor-home', subdirectory: '' },
      skillsSubdirectory: 'skills',
      conflictDiagnostics: 'silent',
      templateCopies: 'copy',
    },
  ],
  // Both backings are already visible where Cursor reads them — the project
  // one through the RW group mount at /workspace/agent, the home one through
  // the cursor-home volume — so no separate view mount is declared, exactly as
  // the adapter never mounted one.
  skillViews: [],
  // No gateway-served credential stub: Cursor authenticates with a bearer
  // header the proxy rewrites, so there is no file to prepare.
  files: [],
  // No speed tiers: Cursor's model parameters are catalogue-specific, so
  // `--speed` is not accepted for cursor groups (only `""` to clear).
  // The adapter in src/providers/cursor.ts still contributes the env
  // (the placeholder CURSOR_API_KEY the proxy rewrites); core realizes every
  // surface above and tells the adapter so through coreOwnsProviderSurfaces.
  legacyHostAdapter: 'required',
});
