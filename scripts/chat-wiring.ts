/**
 * Preflight for `pnpm run chat`: is the `cli/local` messaging group wired to
 * an agent?
 *
 * Setup's recommended path deletes the ping-test agent (which cascades the
 * wiring away) and never creates a terminal agent, yet the final panel
 * advertises `pnpm run chat hi`. Without a wiring the message still routes
 * and wakes a container, but the agent has no destination pointing back at
 * `cli/local`, so the terminal waits out the full 120s timeout with no hint
 * of the cause. This check turns that into an immediate, explained failure.
 *
 * Read-only and best-effort by design: chat must keep working when the check
 * itself can't run (missing/locked DB, schema drift), so callers treat any
 * thrown error as "proceed as before".
 */
import type { DbDriver } from '../src/db/driver.js';

export const CLI_CHANNEL = 'cli';
export const CLI_PLATFORM_ID = 'local';

export type CliWiringStatus = 'wired' | 'no-messaging-group' | 'unwired';

/** How to fix an unwired terminal, shown verbatim by the chat client. */
export const WIRE_HINT =
  'The terminal channel (cli/local) is not wired to an agent, so no reply can ever arrive.\n' +
  'Wire it with your coding agent via /init-first-agent (or /manage-channels), or run:\n' +
  '  pnpm exec tsx scripts/init-cli-agent.ts --display-name "<your name>" --agent-name "<name>\'s Terminal"';

export async function checkCliWiring(db: DbDriver): Promise<CliWiringStatus> {
  const mg = await db.get<{ id: string }>(
    'SELECT id FROM messaging_groups WHERE channel_type = ? AND platform_id = ?',
    CLI_CHANNEL,
    CLI_PLATFORM_ID,
  );
  if (!mg) return 'no-messaging-group';

  const wiring = await db.get<{ id: string }>(
    'SELECT id FROM messaging_group_agents WHERE messaging_group_id = ? LIMIT 1',
    mg.id,
  );
  return wiring ? 'wired' : 'unwired';
}
