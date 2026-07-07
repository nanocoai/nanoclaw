import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Provider is a DB property of a group, set only via
 * `ncl groups config update --provider`. The group-creation contract that a
 * fork's coding agent and its skills depend on must carry zero provider
 * vocabulary — no `--provider` flag passed to, parsed by, or threaded through
 * any creation path. These guards go red if that flag creeps back in.
 *
 * (Prose references to the ncl surface in comments are fine — we assert the
 * absence of the `'--provider'` arg *literal*, not the substring.)
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
}

const CREATION_FILES = [
  'scripts/init-first-agent.ts',
  'scripts/init-cli-agent.ts',
  'setup/register.ts',
  'setup/cli-agent.ts',
  'setup/channels/telegram.ts',
  'setup/channels/discord.ts',
  'setup/channels/slack.ts',
  'setup/channels/whatsapp.ts',
  'setup/channels/signal.ts',
  'setup/channels/imessage.ts',
  'setup/channels/teams.ts',
];

describe('creation is provider-agnostic', () => {
  for (const file of CREATION_FILES) {
    it(`${file} passes/parses no --provider flag`, () => {
      const src = read(file);
      expect(src).not.toContain("'--provider'");
      expect(src).not.toMatch(/case '--provider'/);
    });
  }
});

describe('setup carries the picked provider to creation via a setup-run env var', () => {
  it('picked-provider stashes/reads the pick in the NANOCLAW_PICKED_PROVIDER env var', () => {
    const src = read('setup/lib/picked-provider.ts');
    expect(src).toContain('NANOCLAW_PICKED_PROVIDER');
    // The pick is set into process.env so child creation scripts inherit it —
    // an in-process module global can't cross the process boundary.
    expect(src).toMatch(/process\.env\[/);
  });

  // The creation scripts run as child processes, inherit the env var, and apply
  // it to the group's runtime config — container_configs.provider, the source of
  // truth materialized into container.json (agent_provider is deprecated) — before
  // the welcome wakes the container. No `--provider` flag in the contract (above).
  for (const file of ['scripts/init-first-agent.ts', 'scripts/init-cli-agent.ts']) {
    it(`${file} applies the env-carried provider to container_configs.provider`, () => {
      const src = read(file);
      expect(src).toContain('NANOCLAW_PICKED_PROVIDER');
      expect(src).toMatch(/updateContainerConfigScalars\([^)]*provider:\s*pickedProvider/);
    });
  }
});

describe('codex installs from a hard-wired self-contained script', () => {
  // The provider picker no longer enumerates a remote manifest branch (an
  // unaudited control surface). Codex is offered in trunk and installed by its
  // own setup/add-<name>.sh, exactly like a channel adapter.
  it('setup/add-codex.sh exists', () => {
    expect(fs.existsSync(path.join(repoRoot, 'setup/add-codex.sh'))).toBe(true);
  });

  it('setup/auto.ts installs the picked provider by running setup/add-<name>.sh', () => {
    const src = read('setup/auto.ts');
    expect(src).toContain('setup/add-${agentProvider}.sh');
    // The removed branch-enumeration machinery must not creep back in.
    expect(src).not.toContain('listBranchProviderManifests');
    expect(src).not.toContain('installProviderFromBranch');
  });
});
