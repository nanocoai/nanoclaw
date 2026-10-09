/**
 * scripts/list-plugins.ts — print enabled plugins for a group.
 *
 * Usage:
 *   pnpm exec tsx scripts/list-plugins.ts <group-folder>
 */
import { initOperatorDb } from './lib/db-init.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { listEnabledPlugins } from './lib/plugins-config.js';

const folder = process.argv[2];
if (!folder) {
  console.error('Usage: tsx scripts/list-plugins.ts <group-folder>');
  process.exit(2);
}

initOperatorDb();
if (!getAgentGroupByFolder(folder)) {
  console.error(`No agent group with folder "${folder}"`);
  process.exit(1);
}

console.log(JSON.stringify(listEnabledPlugins(folder), null, 2));
