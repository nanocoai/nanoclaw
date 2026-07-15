/**
 * In-process provider install — the setup-side twin of the channel installs.
 *
 * A provider's `/add-<name>` SKILL.md is the single source of truth for what an
 * install does (copy the payload from the `providers` branch, wire the three
 * provider barrels, merge the CLI manifest entry). This applies that SKILL.md
 * directly through the directive engine (`scripts/skill-apply.ts`) instead of
 * shelling out to a hand-maintained `setup/add-<name>.sh` that has to be kept in
 * lockstep with it — the same move `setup/channels/slack.ts` made for adapters.
 *
 * The provider case differs from a channel in two ways, both handled here:
 *
 *   1. **No install-time secrets.** A provider's credentials are vault-only and
 *      land in a separate auth walk-through (`runAuth`), so the SKILL.md carries
 *      no `nc:prompt` directives. No `resolveInput` is wired — absent means any
 *      prompt would simply defer, and none exists to defer.
 *   2. **Build + auth are owned by the surrounding flow.** The provider SKILL.md
 *      ends with `nc:run effect:build` / `effect:test` / `effect:external` (the
 *      external one re-invokes `--step provider-auth`, which would recurse). The
 *      setup flow already rebuilds the image and runs auth around this call, so
 *      we scope `exec` to apply only the file-mutating commands the engine emits
 *      (the `nc:copy from-branch` git fetch/show) and skip those heavyweight run
 *      directives. The fork-aware remote resolver mirrors slack.ts exactly.
 *
 * Returns the engine's ApplyResult so the caller can decide whether a rebuild is
 * warranted (a fresh install always applied something) and surface any step the
 * engine couldn't apply deterministically (agentTasks / deferred → install
 * failed: a provider install is fully deterministic with no prompts).
 */
import { execSync } from 'node:child_process';

import { applySkill, type ApplyResult } from '../../scripts/skill-apply.js';

/** Commands the directive engine emits that the surrounding setup flow owns. */
function isFlowOwnedCommand(cmd: string): boolean {
  return (
    /\bpnpm\s+run\s+build\b/.test(cmd) ||
    /\btsc\b/.test(cmd) ||
    /container\/build\.sh/.test(cmd) ||
    /\bvitest\b/.test(cmd) ||
    /\bbun\s+test\b/.test(cmd) ||
    // The skill's auth step re-invokes `--step provider-auth` — running it from
    // inside the install would recurse. The flow runs runAuth itself.
    /provider-auth/.test(cmd)
  );
}

export interface ProviderInstallResult {
  apply: ApplyResult;
  /** True when the engine applied at least one mutation (fresh/refreshed install). */
  changed: boolean;
  /** Non-deterministic leftovers — non-empty means the install did not fully apply. */
  blockers: string[];
}

export async function applyProviderSkill(
  skillDir: string,
  projectRoot: string,
): Promise<ProviderInstallResult> {
  // A provider SKILL.md has no prompt directives (vault-only auth runs
  // separately). No resolveInput is passed: absent ⇒ any prompt defers, which
  // is exactly the old defer-all stub's semantics with no stub to maintain.
  const result = await applySkill(skillDir, projectRoot, {
    exec: (cmd) => {
      if (isFlowOwnedCommand(cmd)) return; // build/test/auth are the flow's job
      execSync(cmd, { cwd: projectRoot, stdio: 'pipe' });
    },
    // Fork-aware: reuse the existing resolver (handles upstream/fork remotes and
    // the auto-add-upstream fallback) instead of assuming `origin` — same call
    // setup/channels/slack.ts makes for the `channels` branch.
    resolveRemote: () =>
      execSync('source setup/lib/channels-remote.sh; resolve_channels_remote', {
        cwd: projectRoot,
        shell: '/bin/bash',
        encoding: 'utf8',
      }).trim(),
  });

  const blockers = [...result.agentTasks.map((t) => t.reason), ...result.deferred];
  return {
    apply: result,
    changed: result.applied.length > 0,
    blockers,
  };
}
