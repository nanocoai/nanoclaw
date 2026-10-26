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
 * provider rewrite. An install that changes host code also rebuilds the host
 * and restarts the service, so the running host knows the provider. Any run,
 * re-authentication included, restarts after auth when auth saved settings
 * the host reads at start (OpenCode's endpoint). Provider install
 * skills call this as their auth step so there is exactly one auth
 * implementation per provider.
 * Pass --refresh to intentionally replace the installed payload and update its
 * dependency pins before authentication.
 */
import { buildContainerImage } from './lib/container-build.js';
import { HOST_RESTART_COMMAND, readHostSettings, restartHost } from './lib/host-restart.js';
import * as p from '@clack/prompts';
import { HARDENED_IMAGE_ENV_KEY, readImageSource, writeImageSource } from './lib/registry-state.js';
import { getSetupProvider, listSetupProviders } from './providers/registry.js';
import { applyProviderSkill, loadHostContractModules } from './providers/install.js';
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
  // An install-time restart that found no service, or failed, has already
  // told the operator; a second attempt after auth would only repeat it.
  let restartFailed = false;
  const skillDir = getInstallableProviderDescriptor(name)?.skillDir;
  if (refresh && !skillDir) throw new Error(`Provider '${name}' has no install skill to refresh.`);
  if (skillDir && (!entry || refresh)) {
    const switchToLocal = providerImagePolicy(name) === 'local-required' && readImageSource() === 'hardened';
    if (switchToLocal) {
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
    }
    // Already registered providers authenticate directly unless refresh was
    // requested. That keeps reauthentication usable without registry/build
    // access and preserves the operator's installed payload and pins.
    console.log(`${refresh ? 'Refreshing' : 'Installing'} ${name}…`);
    const { changed, hostChanged, blockers, hostContractModules } = await applyProviderSkill(skillDir, process.cwd(), {
      mode: refresh ? 'refresh' : 'install',
    });
    if (blockers.length) {
      console.error(`Couldn't install ${name}: ${blockers.join('; ')}`);
      process.exit(1);
    }
    if (switchToLocal) writeImageSource('local');
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
    // Before auth: a failed sign-in exits the process, and a re-run finds the
    // provider registered and only re-authenticates, so it never restarts.
    if (hostChanged) restartFailed = restartHostFor(name) !== 'restarted';
    // This process imported src/provider-contracts/index.ts at startup, and
    // ESM caches the barrel, so a line appended to it now never evaluates
    // here; load the contract module directly before the auth step asks the
    // gateway store for model endpoints.
    await loadHostContractModules(hostContractModules);
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

  const settings = readHostSettings();
  await entry.runAuth();
  await entry.runInstallCheck?.();
  // Auth may save settings the host reads only at start (OpenCode's endpoint).
  // A failed build can still emit dist/ (tsc has no noEmitOnError), so this
  // builds and refuses to restart onto a failed build, as the install path does.
  if (!restartFailed && readHostSettings() !== settings) {
    // A host restart adopts running agent containers, which keep the settings
    // they started with until they restart.
    if (restartHostFor(name, { settingsOnly: true }) !== 'no-service') console.log(AGENTS_KEEP_SETTINGS(name));
  }
}

const AGENTS_KEEP_SETTINGS = (name: string) =>
  `Agents already running keep their old ${name} settings until they restart: bin/ncl groups restart --id <group-id>`;

const SERVICE_STEP_COMMAND = 'pnpm exec tsx setup/index.ts --step service';

function restartHostFor(name: string, opts: { settingsOnly?: boolean } = {}): 'restarted' | 'no-service' | 'failed' {
  console.log(`Restarting NanoClaw so the running host loads ${name}…`);
  const restart = restartHost();
  if (restart.status === 'restarted') return 'restarted';
  if (restart.status === 'no-service') {
    // Nothing failed: the service step starts the build made above. A host
    // started by hand is not a service, so name it in the same line, with its
    // running agents when only settings changed.
    const byHand = opts.settingsOnly
      ? 'or restart a host you started by hand, then its running agents: bin/ncl groups restart --id <group-id>'
      : 'or restart a host you started by hand';
    console.log(
      `No NanoClaw service is installed, so nothing was restarted. To use ${name}, start one with ${SERVICE_STEP_COMMAND} (${byHand}).`,
    );
    return 'no-service';
  }
  // Auth only talks to the gateway, so it still runs; the exit code reports
  // the restart the operator has to finish by hand.
  console.error(
    `Couldn't restart NanoClaw (${restart.message}); it runs without ${name} until you run: ${HOST_RESTART_COMMAND}`,
  );
  process.exitCode = 1;
  return 'failed';
}
