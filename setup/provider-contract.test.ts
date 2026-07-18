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
  // Every channel now goes through the SKILL.md driver — the bespoke
  // setup/channels/<channel>.ts flows have been deleted.
  'setup/channels/run-channel-skill.ts',
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
  // the welcome wakes the container, falling back to the instance default
  // (DEFAULT_AGENT_PROVIDER) when the env var is unset. No `--provider` flag in
  // the contract (above). init-first-agent stamps directly via
  // ensureContainerConfig; init-cli-agent threads it through initGroupFilesystem.
  const applyPattern: Record<string, RegExp> = {
    'scripts/init-first-agent.ts': /ensureContainerConfig\([^)]*pickedProvider/,
    'scripts/init-cli-agent.ts': /provider:\s*pickedProvider/,
  };
  for (const [file, pattern] of Object.entries(applyPattern)) {
    it(`${file} applies the env-carried provider to container_configs.provider`, () => {
      const src = read(file);
      expect(src).toContain('NANOCLAW_PICKED_PROVIDER');
      expect(src).toMatch(pattern);
    });
  }
});

describe('bootstrap can restore missing provider-neutral persona files', () => {
  for (const file of ['scripts/init-first-agent.ts', 'scripts/init-cli-agent.ts']) {
    it(`${file} attempts create-only persona staging when reusing a group`, () => {
      const src = read(file);
      expect(src).not.toContain('createdGroup');
      expect(src).toContain(file.includes('first') ? 'stageGroupPersona(' : 'initGroupFilesystem(ag, {');
    });
  }
});

describe('codex installs from its hard-wired /add-codex skill in-process', () => {
  // The provider picker no longer enumerates a remote manifest branch (an
  // unaudited control surface). Codex is offered in trunk and installed by
  // applying its `/add-codex` SKILL.md in-process via the directive engine —
  // the same path channel adapters now take (no drift-prone setup/add-<name>.sh).
  it('the /add-codex skill ships in trunk', () => {
    expect(fs.existsSync(path.join(repoRoot, '.claude/skills/add-codex/SKILL.md'))).toBe(true);
  });

  it('the bespoke setup/add-codex.sh install script is gone', () => {
    expect(fs.existsSync(path.join(repoRoot, 'setup/add-codex.sh'))).toBe(false);
  });

  it('setup/auto.ts installs the picked provider in-process via applyProviderSkill', () => {
    const src = read('setup/auto.ts');
    expect(src).toContain('applyProviderSkill');
    expect(src).toContain('.claude/skills/add-${agentProvider}');
    // No shell-out to a per-provider install script.
    expect(src).not.toContain('setup/add-${agentProvider}.sh');
    // The removed branch-enumeration machinery must not creep back in.
    expect(src).not.toContain('listBranchProviderManifests');
    expect(src).not.toContain('installProviderFromBranch');
  });

  it('setup/provider-auth.ts installs the picked provider in-process via applyProviderSkill', () => {
    const src = read('setup/provider-auth.ts');
    expect(src).toContain('applyProviderSkill');
    expect(src).not.toContain('setup/add-codex.sh');
  });
});
