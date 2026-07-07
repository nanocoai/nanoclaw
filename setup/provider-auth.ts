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
import fs from 'fs';
import path from 'path';

import { getSetupProvider, listSetupProviders } from './providers/registry.js';
// Provider payloads self-register on import.
import './providers/index.js';

// Hard-wired install scripts — the audited control surface (no branch
// enumeration). Each setup/add-<name>.sh is idempotent and self-skips when the
// payload is already wired. Codex is the only manifest-style provider today.
const INSTALL_SCRIPTS: Record<string, string> = {
  codex: 'setup/add-codex.sh',
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
  const script = INSTALL_SCRIPTS[name];
  if (script) {
    // Install OR refresh: the script is idempotent and is also the upgrade
    // path — payload files resync and a bumped Dockerfile pin replaces the
    // local one. Rebuild the image only when the Dockerfile actually changed
    // (payload code is mounted, not baked).
    const dfPath = path.join(process.cwd(), 'container', 'Dockerfile');
    const dfBefore = fs.readFileSync(dfPath, 'utf-8');
    console.log(`${entry ? 'Refreshing' : 'Installing'} ${name}…`);
    execSync(`bash ${script}`, { stdio: 'inherit' });
    if (fs.readFileSync(dfPath, 'utf-8') !== dfBefore) {
      console.log('Dockerfile pin changed — rebuilding the container image…');
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
