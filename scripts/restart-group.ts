/**
 * scripts/restart-group.ts — multi-session-aware container kill helper.
 *
 * Usage:
 *   pnpm exec tsx scripts/restart-group.ts <agent-group-folder>
 *
 * Used by the operator skills (`/install-plugin`, `/add-marketplace`,
 * etc.) after they mutate `container.json`. Lists all docker containers
 * running with this install's label whose name matches the group's
 * `nanoclaw-v2-<folder>-*` prefix, and stops each one. Idle sessions
 * (no running container) are not touched — they'll respawn with the
 * new config naturally on the next message.
 *
 * Race semantics: write `container.json` BEFORE invoking this script,
 * with no awaits between the write and the kill. The host sweep runs
 * every 60s and respawns sessions on due messages; if the sweep fires
 * between our write and our kill, the new container picks up the new
 * config and there's nothing for us to kill — that's fine.
 *
 * Exits non-zero only on docker/runtime errors. "Nothing was running"
 * is a successful exit (operators should still see the new config on
 * next message).
 */
import { execFileSync } from 'child_process';

import { CONTAINER_INSTALL_LABEL } from '../src/config.js';
import { CONTAINER_RUNTIME_BIN } from '../src/container-runtime.js';
import { initOperatorDb } from './lib/db-init.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { getSessionsByAgentGroup } from '../src/db/sessions.js';

interface RestartResult {
  killed: string[];
  idleSessions: number;
  totalSessions: number;
}

async function main(): Promise<void> {
  const folder = process.argv[2];
  if (!folder) {
    console.error('Usage: tsx scripts/restart-group.ts <agent-group-folder>');
    process.exit(2);
  }

  initOperatorDb();

  const group = getAgentGroupByFolder(folder);
  if (!group) {
    console.error(`No agent group with folder "${folder}"`);
    process.exit(1);
  }

  const sessions = getSessionsByAgentGroup(group.id);
  const result: RestartResult = { killed: [], idleSessions: 0, totalSessions: sessions.length };

  // Inventory currently-running containers via docker label, filter by
  // name prefix. Container names are nanoclaw-v2-<folder>-<timestamp>
  // (see container-runner.ts buildContainerArgs).
  const namePrefix = `nanoclaw-v2-${folder}-`;
  let runningNames: string[] = [];
  try {
    const out = execFileSync(
      CONTAINER_RUNTIME_BIN,
      ['ps', '--filter', `label=${CONTAINER_INSTALL_LABEL}`, '--format', '{{.Names}}'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    runningNames = out.trim().split('\n').filter((n) => n.startsWith(namePrefix));
  } catch (err) {
    console.error(`Failed to list running containers: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Kill each. Sequence matters: write-then-kill avoids the sweep-race
  // where a tick between writes and kills could spawn the new container
  // on stale config. The kill calls themselves are independent.
  for (const name of runningNames) {
    try {
      execFileSync(CONTAINER_RUNTIME_BIN, ['stop', '--time', '5', name], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });
      result.killed.push(name);
    } catch (err) {
      // Stop might race with natural exit; treat as best-effort.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`(warning) failed to stop ${name}: ${msg}`);
    }
  }

  // Idle session count = sessions that exist but have no running container.
  result.idleSessions = sessions.length - result.killed.length;

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
