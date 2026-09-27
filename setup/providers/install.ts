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
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { applySkill, type ApplyResult } from '../../scripts/skill-apply.js';
import {
  verifyProviderContracts,
  isPinnedBunVersion,
  type ProviderContractVerification,
} from '../../scripts/provider-contract-verifier.js';
import { parseProviderDescriptor } from './skill-descriptor.js';
import { portableDependencyCommand } from '../../scripts/update-skills.js';

export interface ProviderInstallResult {
  apply: ApplyResult;
  /** True when the engine applied at least one mutation (fresh/refreshed install). */
  changed: boolean;
  /** Non-deterministic leftovers — non-empty means the install did not fully apply. */
  blockers: string[];
  verification: ProviderContractVerification;
  /**
   * Absolute paths of the host contract modules this apply appended to
   * `src/provider-contracts/index.ts`. The setup process imported that barrel
   * at startup, so the ESM cache never re-evaluates the new line; the caller
   * passes these to `loadHostContractModules` so the running process registers
   * the contract (a gateway credential store asks for the provider's model
   * endpoints before the first vault write). Empty when nothing was appended —
   * an already-installed payload was in the barrel when the process started.
   */
  hostContractModules: string[];
}

/** The one barrel whose appended entries the setup process must also load in place. */
const HOST_CONTRACT_BARREL = 'src/provider-contracts/index.ts';

export async function applyProviderSkill(
  skillDir: string,
  projectRoot: string,
  options: { mode?: 'install' | 'refresh' } = {},
): Promise<ProviderInstallResult> {
  let bunOnHost = false;
  try {
    const version = execFileSync('bun', ['--version'], { cwd: projectRoot, stdio: 'pipe', encoding: 'utf8' }).trim();
    bunOnHost = isPinnedBunVersion(projectRoot, version);
  } catch {
    /* Use the container's pinned Bun through pnpm below. */
  }
  // A provider SKILL.md has no prompt directives (vault-only auth runs
  // separately). No resolveInput is passed: absent ⇒ any prompt defers, which
  // is exactly the old defer-all stub's semantics with no stub to maintain.
  const result = await applySkill(skillDir, projectRoot, {
    mode: options.mode ?? 'install',
    skipEffects: ['build', 'test', 'external'],
    resolveDependencyCommand: (request) => portableDependencyCommand(projectRoot, bunOnHost, request),
    exec: (cmd) => execSync(cmd, { cwd: projectRoot, stdio: 'pipe', encoding: 'utf8' }),
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
  // Verify in "required-declared" mode: the provider this skill installs must
  // declare its contract, while any OTHER provider already in this install
  // that predates the contract (a pre-contract payload) is tolerated. Without
  // the option the verifier expects zero undeclared providers and would abort
  // an otherwise-good install over an unrelated legacy payload.
  const verification =
    blockers.length === 0
      ? await verifyProviderContracts(projectRoot, {
          requiredDeclaredProviders: [installedProviderName(skillDir, projectRoot)],
        })
      : { status: 'skipped' as const, checks: [] };
  if (verification.status === 'failed') blockers.push(verification.error ?? 'Provider contract verification failed');
  return {
    apply: result,
    // Captured compatibility predicates run on every apply, but do not alter
    // the image. Only file mutations and dependency commands warrant a build.
    changed: result.journal.some((entry) => entry.op !== 'ran' || entry.undo !== undefined),
    blockers,
    verification,
    hostContractModules: blockers.length === 0 ? appendedHostContractModules(result, projectRoot) : [],
  };
}

/**
 * Resolve each `import './<name>.js';` line the engine appended to the host
 * provider-contracts barrel to the module file it names. Only that barrel is
 * considered: the container barrel's entries run under Bun, not in this
 * process. The `.js` specifier is mapped to the `.ts` source when only the
 * source exists, so the returned path is a real file and not a resolver hint.
 */
export function appendedHostContractModules(result: ApplyResult, projectRoot: string): string[] {
  const modules: string[] = [];
  for (const entry of result.journal) {
    if (entry.op !== 'appended' || path.normalize(entry.path) !== path.normalize(HOST_CONTRACT_BARREL)) continue;
    const specifier = entry.line.match(/^\s*import\s+['"](\.\/[^'"]+)['"]/)?.[1];
    if (!specifier) continue;
    const resolved = path.resolve(projectRoot, path.dirname(HOST_CONTRACT_BARREL), specifier);
    const source = resolved.replace(/\.js$/, '.ts');
    const file = !fs.existsSync(resolved) && fs.existsSync(source) ? source : resolved;
    if (!modules.includes(file)) modules.push(file);
  }
  return modules;
}

/**
 * Import freshly appended host contract modules so their top-level
 * `registerProviderHostContract` call runs in this process. Re-importing the
 * barrel would not do it: its URL is already in the ESM cache with the
 * pre-install body. Each module self-registers on import, exactly as it does
 * when the barrel loads it at host start.
 */
export async function loadHostContractModules(modules: readonly string[]): Promise<void> {
  for (const file of modules) await import(pathToFileURL(file).href);
}

/** The provider a `/add-<name>` skill installs, read from its `nanoclaw-provider` frontmatter. */
export function installedProviderName(skillDir: string, projectRoot: string): string {
  const directory = path.basename(skillDir);
  const markdown = fs.readFileSync(path.join(projectRoot, skillDir, 'SKILL.md'), 'utf-8');
  const descriptor = parseProviderDescriptor(markdown, directory);
  if (!descriptor) throw new Error(`${directory}/SKILL.md has no nanoclaw-provider metadata`);
  return descriptor.value;
}
