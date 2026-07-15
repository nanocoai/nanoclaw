/**
 * Standalone provider auth — the late-adopter entry point.
 *
 * Fresh installs reach a provider's auth walk-through via the setup picker;
 * an existing install adding a provider later runs THIS instead:
 *
 *   pnpm exec tsx setup/index.ts --step provider-auth codex
 *
 * Same walk-through, same vault-only invariant, idempotent (each provider's
 * runAuth short-circuits when its secret already exists) — and unlike
 * re-running full setup, it touches nothing else: no install-wide default
 * provider rewrite, no service changes. Provider install skills call this as
 * their auth step so there is exactly one auth implementation per provider.
 */
import { execSync } from 'child_process';

import { getSetupProvider, listSetupProviders } from './providers/registry.js';
import { applyProviderSkill } from './providers/install.js';
// Provider payloads self-register on import.
import './providers/index.js';

// Hard-wired install skills — the audited control surface (no branch
// enumeration). Each `/add-<name>` SKILL.md is idempotent and self-skips when
// the payload is already wired; it is applied in-process via the directive
// engine (no shell-out to a drift-prone setup/add-<name>.sh). Codex is the only
// manifest-style provider today.
const INSTALL_SKILLS: Record<string, string> = {
  codex: '.claude/skills/add-codex',
};

export async function run(args: string[]): Promise<void> {
  const name = args[0]?.trim().toLowerCase();
  const withAuth = listSetupProviders().filter((entry) => entry.runAuth);

  if (!name) {
    console.error(
      `Usage: pnpm exec tsx setup/index.ts --step provider-auth <provider>\n` +
        `Providers with an auth step: ${withAuth.map((entry) => entry.value).join(', ') || '(none installed)'}`,
    );
    process.exit(1);
  }

  let entry = getSetupProvider(name);
  const skillDir = INSTALL_SKILLS[name];
  if (skillDir) {
    // Install OR refresh: the skill is idempotent and is also the upgrade path
    // — payload files resync and a bumped CLI-manifest pin replaces the local
    // one. Applied in-process via the directive engine; build + auth are this
    // flow's job (the engine's build/test/auth run directives are skipped), so
    // we rebuild the image whenever the install mutated anything (the container
    // CLI manifest is baked into the image, unlike the mounted payload code).
    console.log(`${entry ? 'Refreshing' : 'Installing'} ${name}…`);
    const { changed, blockers } = await applyProviderSkill(skillDir, process.cwd());
    if (blockers.length) {
      console.error(`Couldn't install ${name}: ${blockers.join('; ')}`);
      process.exit(1);
    }
    if (changed) {
      console.log('Provider payload installed — rebuilding the container image…');
      execSync('./container/build.sh', { stdio: 'inherit' });
    }
    if (!entry) {
      await import(`./providers/${name}.js`);
      entry = getSetupProvider(name);
    }
    if (!entry) {
      console.error(`Install completed but ${name} did not register — check setup/providers/${name}.ts`);
      process.exit(1);
    }
  } else if (!entry) {
    console.error(
      `Unknown provider: ${name}. Installed: ${listSetupProviders()
        .map((e) => e.value)
        .join(', ')}.`,
    );
    process.exit(1);
  }
  if (!entry.runAuth) {
    console.error(`Provider "${name}" uses the standard auth flow — run the full setup, or /add-${name}'s steps.`);
    process.exit(1);
  }

  await entry.runAuth();
  await entry.runInstallCheck?.();
}
