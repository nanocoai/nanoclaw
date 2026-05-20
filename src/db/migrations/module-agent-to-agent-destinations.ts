import type { ICentralDb } from '../central/types.js';
import type { Migration } from './index.js';
import { colId, colText, tableSuffix, type MigrationContext } from './helpers.js';

export const moduleAgentToAgentDestinations: Migration = {
  version: 4,
  name: 'agent-destinations',
  up(db: ICentralDb, ctx: MigrationContext) {
    const id = colId(ctx);
    const txt = colText(ctx);
    const t = tableSuffix(ctx);
    db.exec(`
      CREATE TABLE agent_destinations (
        agent_group_id  ${id} NOT NULL REFERENCES agent_groups(id),
        local_name      ${txt} NOT NULL,
        target_type     ${txt} NOT NULL,
        target_id       ${id} NOT NULL,
        created_at      ${txt} NOT NULL,
        PRIMARY KEY (agent_group_id, local_name)
      )${t};
      CREATE INDEX idx_agent_dest_target ON agent_destinations(target_type, target_id);
    `);

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
