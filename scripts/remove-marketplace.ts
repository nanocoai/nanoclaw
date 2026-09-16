/**
 * scripts/remove-marketplace.ts — unregister a plugin marketplace from
 * a group's container.json. Refuses if any plugin from the marketplace
 * is currently enabled (operator must `/uninstall-plugin` first).
 *
 * Usage:
 *   pnpm exec tsx scripts/remove-marketplace.ts <group-folder> <name>
 */
import { spawnSync } from 'child_process';
import path from 'path';

import { initOperatorDb } from './lib/db-init.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { removeMarketplace } from './lib/plugins-config.js';

async function main(): Promise<void> {
  const [, , folder, name] = process.argv;
  if (!folder || !name) {
    console.error('Usage: tsx scripts/remove-marketplace.ts <group-folder> <name>');
    process.exit(2);
  }

  initOperatorDb();
  if (!getAgentGroupByFolder(folder)) {
    console.error(`No agent group with folder "${folder}"`);
    process.exit(1);
  }

  const result = await removeMarketplace(folder, name);

  if (result.blockedBy.length > 0) {
    console.error(
      `Cannot remove marketplace "${name}": it has enabled plugins. ` +
        `Run /uninstall-plugin for each first:\n  ${result.blockedBy.join('\n  ')}`,
    );
    process.exit(1);
  }

  if (!result.removed) {
    console.log(`Marketplace "${name}" was not registered. No change.`);
    return;
  }

  console.log(`Removed marketplace "${name}" from group "${folder}".`);
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
