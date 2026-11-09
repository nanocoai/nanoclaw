import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Agent destinations: per-agent named map of allowed message targets.
 *
 * This table is BOTH the routing map and the ACL. A row exists iff the
 * source agent is permitted to send to the target. No row = unauthorized.
 *
 * target_type: 'channel' references messaging_groups(id)
 * target_type: 'agent'   references agent_groups(id)
 *
 * Names are scoped per source agent — worker-1 may call the admin "parent"
 * while admin calls the child "worker-1". The (agent_group_id, local_name)
 * PK enforces uniqueness within a single agent's namespace only.
 */
// Retains the original `name` ('agent-destinations') so existing DBs that
// already recorded this migration under that name don't re-run it. The
// module- prefix lives on the filename / export identifier only.
export const moduleAgentToAgentDestinations: Migration = {
  version: 4,
  name: 'agent-destinations',
  sqliteOnly: true,
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE agent_destinations (
        agent_group_id  TEXT NOT NULL REFERENCES agent_groups(id),
        local_name      TEXT NOT NULL,
        target_type     TEXT NOT NULL,
        target_id       TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        PRIMARY KEY (agent_group_id, local_name)
      );
      CREATE INDEX idx_agent_dest_target ON agent_destinations(target_type, target_id);
    `);

    // Backfill from existing messaging_group_agents wirings.
    // For each wired (agent, messaging_group), create a destination row
    // using the messaging group's name (normalized) as the local name.
    // Collisions get a -2, -3 suffix within each agent's namespace.
    const rows = db
      .prepare(
        `SELECT mga.agent_group_id, mga.messaging_group_id, mg.channel_type, mg.name
         FROM messaging_group_agents mga
         JOIN messaging_groups mg ON mg.id = mga.messaging_group_id`,
      )
      .all() as Array<{
      agent_group_id: string;
      messaging_group_id: string;
      channel_type: string;
      name: string | null;
    }>;

    const takenByAgent = new Map<string, Set<string>>();
    const insert = db.prepare(
      `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES (?, ?, 'channel', ?, ?)`,
    );
    const now = new Date().toISOString();

    for (const row of rows) {
      const base = normalizeName(row.name || `${row.channel_type}-${row.messaging_group_id.slice(0, 8)}`);
      const taken = takenByAgent.get(row.agent_group_id) ?? new Set<string>();
      let localName = base;
      let suffix = 2;
      while (taken.has(localName)) {
        localName = `${base}-${suffix}`;
        suffix++;
      }
      taken.add(localName);
      takenByAgent.set(row.agent_group_id, taken);
      insert.run(row.agent_group_id, localName, row.messaging_group_id, now);
    }
  },
};

function normalizeName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unnamed'
  );
}
