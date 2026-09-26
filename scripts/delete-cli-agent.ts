/**
 * Delete the scratch CLI agent created during setup's ping-pong test.
 *
 * Dynamically finds and removes all rows referencing the agent group
 * (any table with an agent_group_id column), deletes the agent group
 * itself, stops and removes the group's container(s), and removes the
 * groups/<folder>/ directory. Leaves the CLI messaging group intact so it
 * can be reused for a new agent.
 *
 * Containers are stopped before the folder they mount is removed: the host is
 * the only thing that stops idle ones. Deleting the rows blocks new spawns but
 * not one already in flight, hence the re-list sweep; a spawn slower than the
 * sweep is reported as still present.
 *
 * Usage:
 *   pnpm exec tsx scripts/delete-cli-agent.ts --folder <folder-name>
 */
import fs from 'fs';
import path from 'path';

import { CENTRAL_DB_PATH, DATA_DIR, INSTALL_SLUG } from '../src/config.js';
import { CONTAINER_RUNTIME_BIN } from '../src/container-runtime.js';
import { getAgentGroupByFolder, deleteAgentGroup } from '../src/db/agent-groups.js';
import { closeDb, initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import type { AgentGroup } from '../src/types.js';
import { listGroupContainers, stopGroupContainers } from './update/group-containers.js';
import { createCommandRunner } from './update/service.js';

/** How long each sweep waits for an in-flight spawn to reach the runtime. */
const SWEEP_GRACE_MS = 2000;
/** Re-list passes after the first stop; a pass that finds nothing ends the sweep. */
const SWEEP_PASSES = 2;

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

const containerOptions = {
  runtime: process.env.CONTAINER_RUNTIME ?? CONTAINER_RUNTIME_BIN,
  installSlug: INSTALL_SLUG,
  agentGroupId: ag.id,
  runner: createCommandRunner(),
};
const seen = new Set<string>();
const confirmedStopped = new Set<string>();
let pass = stopGroupContainers(containerOptions);
// Only a listing that worked and came back empty says the group has nothing
// left; a failed `ps` proves nothing, so it keeps the sweep going.
const settled = (result: typeof pass) => result.listed.length === 0 && result.failures.length === 0;
for (let sweep = 0; ; sweep++) {
  for (const id of pass.listed) seen.add(id);
  for (const id of pass.stopped) confirmedStopped.add(id);
  if (sweep === SWEEP_PASSES || (sweep > 0 && settled(pass))) break;
  await new Promise((resolve) => setTimeout(resolve, SWEEP_GRACE_MS));
  pass = stopGroupContainers(containerOptions);
}
// A pass that stopped something does not see a container started after its
// listing, so unless the sweep ended on an empty listing, list once more.
const final = settled(pass) ? { ok: true as const, ids: [] } : listGroupContainers(containerOptions);
// Report the end state: everything seen and no longer listed was stopped.
const stopped = final.ok ? [...seen].filter((id) => !final.ids.includes(id)) : [...confirmedStopped];
if (stopped.length > 0) {
  console.log(`Stopped ${stopped.length} container(s) for ${args.folder}: ${stopped.join(', ')}`);
}
if (final.ok && final.ids.length > 0) {
  console.warn(`${final.ids.length} container(s) for ${args.folder} still present: ${final.ids.join(', ')}`);
}
// The last pass's errors explain a survivor only if that pass already tried it;
// a container that appeared later has no error of its own.
const unresolved = final.ok ? final.ids.some((id) => pass.listed.includes(id)) : true;
if (unresolved) {
  const failures = new Set([...pass.failures, ...(final.ok ? [] : [final.failure])]);
  for (const failure of failures) {
    console.warn(`Could not clean up container(s) for ${args.folder}: ${failure}`);
  }
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
