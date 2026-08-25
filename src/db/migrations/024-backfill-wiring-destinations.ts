import type { PortableMigration } from './index.js';

/**
 * Backfill the `agent_destinations` channel row for wirings that never got
 * one.
 *
 * The `agent-destinations` migration backfilled every wiring that existed
 * when it ran, and each wiring-creation path now provisions the companion
 * row at wiring time. Wirings created in between have neither: the agent is
 * wired to the chat and receives from it, but the chat is absent from the
 * agent's destination map.
 *
 * That gap is silent. Sending requires a named destination, so the agent
 * composes a correctly-addressed reply, finds no name to address, and the
 * block is dropped inside the container. The warning rides the attach stream
 * to the host but only lands at debug level, so a default install
 * (`LOG_LEVEL=info`) sees nothing and the message is still acknowledged as
 * processed. From the chat it reads as the agent ignoring you.
 *
 * Only wirings created after `agent-destinations` ran are eligible. That
 * migration left every older wiring with a row, so an older wiring missing
 * one had it removed deliberately — `ncl destinations remove` is an
 * approval-gated revocation, and this table's row *is* the ACL (no row =
 * unauthorized). Restoring those would silently re-grant a permission a
 * human took away.
 *
 * Existing destinations are authoritative: a wiring that already has a
 * channel destination keeps it, custom local names are never rewritten, and
 * collisions resolve with a numeric suffix inside the owning agent's
 * namespace. Re-running changes nothing.
 */
export const migration024: PortableMigration = {
  version: 24,
  name: 'backfill-wiring-destinations',
  async up(db) {
    // The table belongs to the agent-to-agent module — without it there is
    // nothing to repair.
    if (!(await db.hasTable('agent_destinations'))) return;

    // The cutoff. `agent-destinations` stamps this row when it backfills, so
    // its timestamp is exactly the boundary between "was covered by that
    // backfill" and "created afterwards". Without the stamp the checkout's
    // history is unknown, and re-granting a revoked destination is worse than
    // leaving a broken one — so do nothing.
    const stamp = await db.get<{ applied: string }>(
      'SELECT applied FROM schema_version WHERE name = ?',
      'agent-destinations',
    );
    if (!stamp?.applied) return;

    const taken = new Map<string, Set<string>>();
    const existing = await db.all<{ agent_group_id: string; local_name: string }>(
      'SELECT agent_group_id, local_name FROM agent_destinations',
    );
    for (const row of existing) {
      const names = taken.get(row.agent_group_id) ?? new Set<string>();
      names.add(row.local_name);
      taken.set(row.agent_group_id, names);
    }

    // ORDER BY makes the generated suffixes deterministic when one agent is
    // missing several destinations whose chats share a name.
    const missing = await db.all<{
      agent_group_id: string;
      messaging_group_id: string;
      created_at: string;
      channel_type: string;
      name: string | null;
    }>(
      `SELECT mga.agent_group_id, mga.messaging_group_id, mga.created_at, mg.channel_type, mg.name
         FROM messaging_group_agents mga
         JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
         LEFT JOIN agent_destinations ad
           ON ad.agent_group_id = mga.agent_group_id
          AND ad.target_type = 'channel'
          AND ad.target_id = mga.messaging_group_id
        WHERE ad.agent_group_id IS NULL
          AND mga.created_at >= ?
        ORDER BY mga.agent_group_id, mga.created_at, mga.id`,
      stamp.applied,
    );

    for (const row of missing) {
      const base = normalizeName(row.name || `${row.channel_type}-${row.messaging_group_id.slice(0, 8)}`);
      const names = taken.get(row.agent_group_id) ?? new Set<string>();
      let localName = base;
      let suffix = 2;
      while (names.has(localName)) {
        localName = `${base}-${suffix}`;
        suffix++;
      }
      names.add(localName);
      taken.set(row.agent_group_id, names);

      // The destination should have existed from the moment the wiring did,
      // which is what the wiring-time path records too.
      await db.run(
        `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
         VALUES (?, ?, 'channel', ?, ?)`,
        row.agent_group_id,
        localName,
        row.messaging_group_id,
        row.created_at,
      );
    }
  },
};

/** Kept local so a later change to the shared helper cannot alter the names
 *  this migration already wrote. Mirrors `agent-destinations`. */
function normalizeName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unnamed'
  );
}
