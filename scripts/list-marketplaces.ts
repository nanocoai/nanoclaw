/**
 * scripts/list-marketplaces.ts — print the registered marketplaces for
 * a group.
 *
 * Usage:
 *   pnpm exec tsx scripts/list-marketplaces.ts <group-folder>
 *
 * Outputs JSON to stdout (the SKILL.md prompts Claude to format it).
 */
import { initOperatorDb } from './lib/db-init.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { listMarketplaces } from './lib/plugins-config.js';

const folder = process.argv[2];
if (!folder) {
  console.error('Usage: tsx scripts/list-marketplaces.ts <group-folder>');
  process.exit(2);
}

initOperatorDb();
if (!getAgentGroupByFolder(folder)) {
  console.error(`No agent group with folder "${folder}"`);
  process.exit(1);
}

console.log(JSON.stringify(listMarketplaces(folder), null, 2));
