/**
 * scripts/install-plugin.ts — enable a plugin in a group's
 * container.json. Optionally registers the marketplace inline via
 * --source for the "register and install in one shot" workflow.
 *
 * Usage:
 *   pnpm exec tsx scripts/install-plugin.ts <group-folder> <plugin-spec> [--source <json>]
 *
 * <plugin-spec> is `name@marketplace`. If <marketplace> isn't already
 * registered for the group, --source is required.
 *
 * Examples:
 *   tsx scripts/install-plugin.ts mygroup fmt@acme
 *   tsx scripts/install-plugin.ts mygroup fmt@acme \
 *     --source '{"source":"github","repo":"acme/plugins","ref":"main"}'
 *
 * Private-repo note: if the source is a private github/git URL, run
 * `/setup-private-plugins` first to wire the OneCLI vault entry that
 * lets the SDK clone privately. Without it the SDK clone fails at
 * session init with a visible plugin_install:failed event but the
 * session continues without that plugin.
 */
import { spawnSync } from 'child_process';
import path from 'path';

import { initOperatorDb } from './lib/db-init.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { installPlugin } from './lib/plugins-config.js';
import { parseMarketplaceSource } from './lib/marketplace-source-validator.js';
import { findGithubGitSecret } from './lib/onecli-vault-helpers.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error(
      'Usage: tsx scripts/install-plugin.ts <group-folder> <plugin-spec> [--source <source-json>]',
    );
    process.exit(2);
  }
  const folder = args[0];
  const pluginSpec = args[1];
  let inlineSourceJson: string | undefined;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--source' && i + 1 < args.length) {
      inlineSourceJson = args[i + 1];
      i++;
    }
  }

  initOperatorDb();
  if (!getAgentGroupByFolder(folder)) {
    console.error(`No agent group with folder "${folder}"`);
    process.exit(1);
  }

  let inlineSource;
  if (inlineSourceJson) {
    try {
      inlineSource = parseMarketplaceSource(JSON.parse(inlineSourceJson));
    } catch (err) {
      console.error(`Invalid --source: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    // Private-github pre-warning. If the source is a github/git URL and
    // the OneCLI vault doesn't have a github.com entry with the right
    // shape, the SDK clone will likely fail at session init. We DON'T
    // block — operator may have other auth wired (SSH agent etc.).
    const isGithubLike =
      inlineSource.source === 'github' ||
      (inlineSource.source === 'git' && /github\.com/i.test(inlineSource.url));
    if (isGithubLike && !findGithubGitSecret()) {
      console.error(
        '(warning) Source points at github.com but no OneCLI vault entry was found ' +
          'for github.com with `Authorization: Basic` injection. If this is a private ' +
          'repository the SDK clone will fail at session init. Run /setup-private-plugins ' +
          'to wire the github auth before continuing if needed. Proceeding with install...',
      );
    }
  }

  let result;
  try {
    result = await installPlugin(folder, pluginSpec, inlineSource);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (!result.wasEnabled && !result.marketplaceAdded) {
    console.log(`Plugin "${pluginSpec}" already enabled. No change.`);
    return;
  }

  if (result.marketplaceAdded && result.wasEnabled) {
    console.log(`Registered marketplace and enabled plugin "${pluginSpec}" in group "${folder}".`);
  } else if (result.marketplaceAdded) {
    console.log(`Updated inline marketplace source for plugin "${pluginSpec}".`);
  } else {
    console.log(`Enabled plugin "${pluginSpec}" in group "${folder}".`);
  }

  restart(folder);
}

function restart(folder: string): void {
  const scriptPath = path.join(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), 'restart-group.ts');
  const result = spawnSync('pnpm', ['exec', 'tsx', scriptPath, folder], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('Restart helper exited with non-zero status; the new config will apply on next idle respawn.');
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
