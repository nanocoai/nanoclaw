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
 * Pass --refresh to intentionally replace the installed payload and update its
 * dependency pins before authentication.
 */
import { buildContainerImage } from './lib/container-build.js';
import * as p from '@clack/prompts';
import { HARDENED_IMAGE_ENV_KEY, readImageSource, writeImageSource } from './lib/registry-state.js';
import { getSetupProvider, listSetupProviders } from './providers/registry.js';
import { applyProviderSkill } from './providers/install.js';
import { getInstallableProviderDescriptor, providerImagePolicy } from './providers/skill-descriptor.js';
// Provider payloads self-register on import.
import './providers/index.js';

export async function run(args: string[]): Promise<void> {
  const name = args[0]?.trim().toLowerCase();
  const refresh = args.slice(1).includes('--refresh');
  const withAuth = listSetupProviders().filter((entry) => entry.runAuth);

  if (!name || args.slice(1).some((arg) => arg !== '--refresh')) {
    console.error(
      `Usage: pnpm exec tsx setup/index.ts --step provider-auth <provider> [--refresh]\n` +
        `Providers with an auth step: ${withAuth.map((entry) => entry.value).join(', ') || '(none installed)'}`,
    );
    process.exit(1);
  }

  let entry = getSetupProvider(name);
  const skillDir = getInstallableProviderDescriptor(name)?.skillDir;
  if (refresh && !skillDir) throw new Error(`Provider '${name}' has no install skill to refresh.`);
  if (skillDir && (!entry || refresh)) {
    if (providerImagePolicy(name) === 'local-required' && readImageSource() === 'hardened') {
      if (process.env[HARDENED_IMAGE_ENV_KEY]?.trim().toLowerCase() === 'true') {
        throw new Error(
          `Unset exported ${HARDENED_IMAGE_ENV_KEY} before installing a provider that requires a local image.`,
        );
      }
      const local = await p.confirm({
        message: `${name} needs a sandbox image built on this machine. Stop using the pre-built one?`,
        initialValue: true,
      });
      if (p.isCancel(local) || !local)
        throw new Error('Provider installation cancelled; the existing image and payload are unchanged.');
      writeImageSource('local');
    }
    // Already registered providers authenticate directly unless refresh was
    // requested. That keeps reauthentication usable without registry/build
    // access and preserves the operator's installed payload and pins.
    console.log(`${refresh ? 'Refreshing' : 'Installing'} ${name}…`);
    const { changed, blockers } = await applyProviderSkill(skillDir, process.cwd(), {
      mode: refresh ? 'refresh' : 'install',
    });
    if (blockers.length) {
      console.error(`Couldn't install ${name}: ${blockers.join('; ')}`);
      process.exit(1);
    }
    if (changed) {
      console.log('Provider payload installed — rebuilding the container image…');
      const rebuild = buildContainerImage();
      if (!rebuild.ok) {
        // Stop here rather than authenticating a runtime the image can't start:
        // the payload files are mounted, but the CLI manifest is baked in.
        console.error(`Couldn't rebuild the container image for ${name}: ${rebuild.message}`);
        if (rebuild.hint) console.error(rebuild.hint);
        process.exit(1);
      }
    }
    if (!entry) {
      // Resolve after installation; a bundler's static glob cannot include a
      // provider module that was absent when this setup module first loaded.
      const installedModule = `./providers/${name}.js`;
      await import(installedModule);
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
