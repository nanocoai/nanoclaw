/**
 * scripts/add-marketplace.ts — register a plugin marketplace in a
 * group's container.json. Mirrors `claude plugin marketplace add` but
 * scoped to one NanoClaw agent group. After the mutation the group's
 * containers are killed so the new marketplace takes effect on the
 * next message (the SDK installs declared marketplaces at session
 * init when CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1 is set).
 *
 * Usage:
 *   pnpm exec tsx scripts/add-marketplace.ts <group-folder> <name> <source-json>
 *
 * <source-json> is a JSON string matching the SDK's
 * `extraKnownMarketplaces` source schema. The eight variants are
 * documented in src/container-config.ts:ExtraKnownMarketplaceSource.
 *
 * Examples:
 *   tsx scripts/add-marketplace.ts mygroup acme \
 *     '{"source":"github","repo":"acme/plugins","ref":"main"}'
 *
 *   tsx scripts/add-marketplace.ts mygroup local-test \
 *     '{"source":"directory","path":"/Users/me/my-marketplace"}'
 */
import { spawnSync } from 'child_process';
import path from 'path';

import { initOperatorDb } from './lib/db-init.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { addMarketplace } from './lib/plugins-config.js';
import { parseMarketplaceSource } from './lib/marketplace-source-validator.js';

async function main(): Promise<void> {
  const [, , folder, name, sourceJson] = process.argv;
  if (!folder || !name || !sourceJson) {
    console.error('Usage: tsx scripts/add-marketplace.ts <group-folder> <name> <source-json>');
    process.exit(2);
  }

  initOperatorDb();
  if (!getAgentGroupByFolder(folder)) {
    console.error(`No agent group with folder "${folder}"`);
    process.exit(1);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(sourceJson);
  } catch (err) {
    console.error(`Invalid source JSON: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  let source;
  try {
    source = parseMarketplaceSource(parsedJson);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const result = await addMarketplace(folder, name, source);

  if (result.added) {
    console.log(`Registered marketplace "${name}" in group "${folder}".`);
  } else if (result.replaced) {
    console.log(`Updated marketplace "${name}" source in group "${folder}".`);
  } else {
    console.log(`Marketplace "${name}" already registered with the same source. No change.`);
    return; // No restart needed.
  }

  // Restart the group so the new marketplace takes effect.
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
