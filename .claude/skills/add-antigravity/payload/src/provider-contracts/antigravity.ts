import { registerProviderHostContract } from './registry.js';

// Pinned literal, not the core's constant: a core seam bump must fail this
// payload's version check until the payload is refreshed to match.
const HOST_SEAM_VERSION = 1;

// Antigravity CLI (`agy`) 1.5.8 in Gemini API key mode. Every surface below is
// one the pre-contract adapter (src/providers/antigravity.ts) would otherwise
// build by hand; core realizes them and tells the adapter so through
// coreOwnsProviderSurfaces.
registerProviderHostContract('antigravity', {
  seamVersion: HOST_SEAM_VERSION,
  modelDomains: [
    // Model calls: POST /v1beta/models/<model>:streamGenerateContent with the
    // key in `x-goog-api-key`. The gateway swaps the placeholder there.
    'generativelanguage.googleapis.com',
    // agy's telemetry. It is sent through HTTPS_PROXY like the model calls and
    // has no off switch in headless API-key mode (`--disable_telemetry` is
    // undefined and `--settings` rejects telemetry keys). Leaving it out would
    // raise a gateway approval prompt in every Antigravity group.
    'play.googleapis.com',
  ],
  // The credential host the gateway connection is scoped to.
  modelEndpoints: { api: 'https://generativelanguage.googleapis.com' },
  projectDocument: {
    fileName: 'AGENTS.md',
    containerPath: '/workspace/agent/AGENTS.md',
    mountClass: 'allowlisted-extra',
    // agy reads workspace instruction files of up to 24 KB; core trims the
    // composed document to fit rather than letting agy cut it off silently.
    maxBytes: 24 * 1024,
    instructions: {
      // Other places agy loads standing instructions from in the workspace, so
      // memory written there would change the agent's rules. `.agents` stands
      // for `.agents/AGENTS.md` and `.agents/GEMINI.md`: the contract accepts
      // only single file or directory names here, not nested paths.
      nativeOverrideFiles: ['GEMINI.md', '.agents'],
      nativeSkills: {
        // agy discovers global skills under ~/.gemini/config/skills, which the
        // gemini-home volume carries (see the skill backing below).
        discoveryPath: '/home/node/.gemini/config/skills',
        sharedSource: '/app/skills',
        selfAuthoredHome: '~/.gemini/config/skills',
        persistentRoots: ['~/.gemini'],
        ruleBearingInlined: true,
      },
    },
  },
  stateVolumes: [
    {
      // agy's whole home: settings.json, mcp_config.json, the always-on rule
      // file the runtime rewrites before each spawn, global skills, and the
      // conversation database `--conversation <id>` resumes from. Per group and
      // persistent, so a continuation survives container respawns.
      id: 'gemini-home',
      directory: '.gemini-shared',
      containerPath: '/home/node/.gemini',
      scope: 'group',
      mode: 'rw',
      mountClass: 'allowlisted-extra',
    },
  ],
  skillBackings: [
    {
      // ~/.gemini/config/skills, inside the gemini-home volume. Discovery is
      // home-only: the agent workspace has no project skills layer to fill.
      id: 'antigravity-home-skills',
      location: { kind: 'state-volume', volumeId: 'gemini-home', subdirectory: 'config' },
      skillsSubdirectory: 'skills',
      conflictDiagnostics: 'silent',
      templateCopies: 'copy',
    },
  ],
  // The backing is already visible through the gemini-home volume mount, so
  // no separate view is mounted.
  skillViews: [],
  // No credential file to prepare: agy sends the placeholder key as a header
  // that the gateway rewrites.
  files: [],
  // No speed tiers: agy has no speed knob (effort is part of the model slug or
  // `--effort`), so `--speed` is not accepted for antigravity groups.
  // The adapter still contributes the environment, which a contract cannot
  // declare.
  legacyHostAdapter: 'required',
});
