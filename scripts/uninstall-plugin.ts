/**
 * scripts/uninstall-plugin.ts — disable a plugin in a group's
 * container.json. The marketplace registration stays so other plugins
 * from it remain installable.
 *
 * Usage:
 *   pnpm exec tsx scripts/uninstall-plugin.ts <group-folder> <plugin-spec>
 */
import { spawnSync } from 'child_process';
import path from 'path';

import { initOperatorDb } from './lib/db-init.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { uninstallPlugin } from './lib/plugins-config.js';

async function main(): Promise<void> {
  const [, , folder, pluginSpec] = process.argv;
  if (!folder || !pluginSpec) {
    console.error('Usage: tsx scripts/uninstall-plugin.ts <group-folder> <plugin-spec>');
    process.exit(2);
  }

  initOperatorDb();
  if (!getAgentGroupByFolder(folder)) {
    console.error(`No agent group with folder "${folder}"`);
    process.exit(1);
  }

  let result;
  try {
    result = await uninstallPlugin(folder, pluginSpec);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (!result.wasDisabled) {
    console.log(`Plugin "${pluginSpec}" was not enabled. No change.`);
    return;
  }

  console.log(`Disabled plugin "${pluginSpec}" in group "${folder}".`);
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
