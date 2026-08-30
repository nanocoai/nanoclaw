/**
 * Terminal-mode resolution for code-mode sessions (terminal-architecture:
 * tmux + channels). One deployment-level knob, read on BOTH sides of the
 * contract:
 *
 *  - host side (here): attach resolution picks the exec argv — the tmux
 *    client for 'tmux', the frozen attach-client entrypoint otherwise.
 *  - runner side: index.ts reads the same variable from the container env
 *    to decide who owns the session (the deployment stages it into code-mode
 *    sessions the same way NANOCLAW_CODE_PERMISSION_MODE travels).
 *
 * The two sides tolerate skew safely: a tmux-mode runner with an
 * attach-mode host serves no attach socket, so attach fails loudly (client
 * exit EXIT_NO_SOCKET), never silently — and vice versa the tmux client
 * reports no server. Default is the classic stack until the term-audit
 * parity matrix over tmux gates the flip.
 */
import { readEnvFile } from '../env.js';

export type CodeTermMode = 'attach' | 'tmux';

/** tmux IS the default (owner decision, 2026-08-28: the parity gate the
 * phase-1 rollout waited on is passed — proven on the POC and the
 * stanford-demo bring-up). 'attach' is the explicit opt-out; anything else,
 * including a typo, falls to the default. The runner keeps the safe end a
 * different way: an image with no tmux binary falls back to attach at boot
 * instead of stranding the session. */
export function resolveCodeTermMode(raw: string | undefined): CodeTermMode {
  return raw?.trim() === 'attach' ? 'attach' : 'tmux';
}

/** Deployment-level mode: host process env first, then the .env file
 * (readEnvFile never loads into process.env — see env.ts). */
export function deploymentTermMode(env: NodeJS.ProcessEnv = process.env): CodeTermMode {
  return resolveCodeTermMode(
    env.NANOCLAW_CODE_TERM?.trim() || readEnvFile(['NANOCLAW_CODE_TERM']).NANOCLAW_CODE_TERM?.trim() || undefined,
  );
}
