/**
 * OpenAI Codex adapter for the setup-helper registry.
 *
 * Headless: `codex exec "<prompt>"` — non-interactive subcommand,
 * prints the agent's reply to stdout.
 * Handoff:  `codex "<prompt>"` — bare `codex [PROMPT]` opens the
 * interactive TUI with the prompt as the opening message.
 *
 * Auth probe: codex doesn't expose a non-network `auth status` we can
 * probe in <1s. Treat as `undefined` — setup will proceed and let
 * actual usage surface the error if auth is broken.
 *
 * Install: setup installs the pinned Codex CLI through pnpm global so
 * Codex-only users do not need Claude Code just to recover from setup
 * failures or run the subscription login flow.
 */
import { execSync } from 'child_process';

import type { HeadlessOpts, SpawnArgs, AiCodingCli } from './types.js';

function isInstalled(): boolean {
  try {
    execSync('command -v codex', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isAuthenticated(): boolean | undefined {
  if (!isInstalled()) return false;
  // codex has no fast offline auth-probe; we let actual invocation surface
  // the error rather than block setup on a network round-trip.
  return undefined;
}

function headless(prompt: string, _opts: HeadlessOpts = {}): SpawnArgs {
  // `codex exec` already permits tool use in its sandbox; opts.tools is
  // accepted for API uniformity but doesn't change the argv.
  return {
    args: ['exec', prompt],
    stdin: 'ignore',
    output: 'pipe',
  };
}

function handoff(prompt: string): SpawnArgs {
  return {
    args: [prompt],
    stdin: 'inherit',
    output: 'inherit',
  };
}

export const codexCli: AiCodingCli = {
  name: 'codex',
  displayName: 'OpenAI Codex',
  binary: 'codex',
  isInstalled,
  isAuthenticated,
  installScript: 'setup/install-codex-cli.sh',
  installInstructions: 'npm install -g @openai/codex   (or: pnpm install -g @openai/codex)',
  login(): null {
    return null;
  },
  loginInstructions: 'Set OPENAI_API_KEY in your environment, or run: codex (it will prompt on first use)',
  headless,
  handoff,
};
