/**
 * Claude Code adapter for the setup-helper registry.
 *
 * Headless: `claude -p --output-format text "<prompt>"` — print mode.
 * Handoff:  `claude "<prompt>"` — opens the interactive TUI with the
 * prompt as the opening message; user types `/exit` to return.
 *
 * Auth probe: `claude auth status` exits 0 when authed (any path —
 * subscription token, OAuth, API key — counts).
 */
import { execSync } from 'child_process';
import path from 'path';

import type { HeadlessOpts, SpawnArgs, AiCodingCli } from './types.js';

function isInstalled(): boolean {
  try {
    execSync('command -v claude', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isAuthenticated(): boolean | undefined {
  if (!isInstalled()) return false;
  try {
    execSync('claude auth status', { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function headless(prompt: string, opts: HeadlessOpts = {}): SpawnArgs {
  const args = ['-p', '--output-format', 'text'];
  if (opts.tools) {
    // bypassPermissions lets the assist flow Read files and run Bash
    // diagnostics without per-tool prompts in print mode. Pure text
    // utility calls (default) don't need this.
    args.push('--permission-mode', 'bypassPermissions');
  }
  args.push(prompt);
  return {
    args,
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

export const claudeCli: AiCodingCli = {
  name: 'claude',
  displayName: 'Claude Code',
  binary: 'claude',
  isInstalled,
  isAuthenticated,
  installScript: path.join('setup', 'install-claude.sh'),
  headless,
  handoff,
};
