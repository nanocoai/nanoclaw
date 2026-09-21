/**
 * Delete the scratch CLI agent created during setup's ping-pong test.
 *
 * Dynamically finds and removes all rows referencing the agent group
 * (any table with an agent_group_id column), deletes the agent group
 * itself, and removes the groups/<folder>/ directory. Leaves the CLI
 * messaging group intact so it can be reused for a new agent.
 *
 * Usage:
 *   pnpm exec tsx scripts/delete-cli-agent.ts --folder <folder-name>
 */
import fs from 'fs';
import path from 'path';

import { CENTRAL_DB_PATH, DATA_DIR } from '../src/config.js';
import { getAgentGroupByFolder, deleteAgentGroup } from '../src/db/agent-groups.js';
import { closeDb, initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import type { AgentGroup } from '../src/types.js';

interface Args {
  folder: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let folder = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--folder' && argv[i + 1]) folder = argv[++i];
  }
  if (!folder) {
    console.error('usage: pnpm exec tsx scripts/delete-cli-agent.ts --folder <folder-name>');
    process.exit(1);
  }
  return { folder };
}

const args = parseArgs();

const db = await initDb(CENTRAL_DB_PATH);
let ag: AgentGroup | undefined;
try {
  await runMigrations(db);
  ag = await getAgentGroupByFolder(args.folder);
  if (ag) {
    if (!db.columnOwners) throw new Error(`Central DB driver "${db.dialect}" does not support column discovery`);
    const group = ag;
    await db.transaction(async () => {
      const tables = (await db.columnOwners!('agent_group_id')).filter((name) => name !== 'agent_groups');
      for (const name of tables) {
        const quotedName = `"${name.replaceAll('"', '""')}"`;
        await db.run(`DELETE FROM ${quotedName} WHERE agent_group_id = ?`, group.id);
      }
      await deleteAgentGroup(group.id);
    });
  }
} finally {
  await closeDb();
}

if (!ag) {
  console.log(`No agent group with folder "${args.folder}" — nothing to delete.`);
  process.exit(0);
}

// Remove the groups/<folder>/ directory.
const groupDir = path.join(process.cwd(), 'groups', args.folder);
if (fs.existsSync(groupDir)) {
  fs.rmSync(groupDir, { recursive: true });
}

// Remove session data on disk.
const sessionsDir = path.join(DATA_DIR, 'v2-sessions', ag.id);
if (fs.existsSync(sessionsDir)) {
  fs.rmSync(sessionsDir, { recursive: true });
}

console.log(`Deleted agent group ${ag.id} (${args.folder}).`);
