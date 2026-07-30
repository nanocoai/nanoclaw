import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Repair wirings created after `agent-destinations` had already run but
 * before every wiring-creation path provisioned its companion destination.
 *
 * Existing destinations are authoritative: keep their local names and only
 * add a channel destination when the wiring's target has none.
 */
export const migration022: Migration = {
  version: 22,
  name: 'backfill-wiring-destinations',
  up(db: Database.Database) {
    const takenByAgent = new Map<string, Set<string>>();
    const existingNames = db.prepare('SELECT agent_group_id, local_name FROM agent_destinations').all() as Array<{
      agent_group_id: string;
      local_name: string;
    }>;

    for (const row of existingNames) {
      const taken = takenByAgent.get(row.agent_group_id) ?? new Set<string>();
      taken.add(row.local_name);
      takenByAgent.set(row.agent_group_id, taken);
    }

    const missing = db
      .prepare(
        `SELECT
           mga.agent_group_id,
           mga.messaging_group_id,
           mga.created_at,
           mg.channel_type,
           mg.name
         FROM messaging_group_agents mga
         JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
         LEFT JOIN agent_destinations ad
           ON ad.agent_group_id = mga.agent_group_id
          AND ad.target_type = 'channel'
          AND ad.target_id = mga.messaging_group_id
         WHERE ad.agent_group_id IS NULL
         ORDER BY mga.agent_group_id, mga.created_at, mga.id`,
      )
      .all() as Array<{
      agent_group_id: string;
      messaging_group_id: string;
      created_at: string;
      channel_type: string;
      name: string | null;
    }>;

    const insert = db.prepare(
      `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES (?, ?, 'channel', ?, ?)`,
    );

    for (const row of missing) {
      const base = normalizeName(row.name || `${row.channel_type}-${row.messaging_group_id.slice(0, 8)}`);
      const taken = takenByAgent.get(row.agent_group_id) ?? new Set<string>();
      let localName = base;
      let suffix = 2;
      while (taken.has(localName)) {
        localName = `${base}-${suffix}`;
        suffix++;
      }

      insert.run(row.agent_group_id, localName, row.messaging_group_id, row.created_at);
      taken.add(localName);
      takenByAgent.set(row.agent_group_id, taken);
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
