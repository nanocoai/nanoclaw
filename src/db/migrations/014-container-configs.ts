import type { ICentralDb } from '../central/types.js';
import type { Migration } from './index.js';
import { colId, colJson, colText, tableSuffix, type MigrationContext } from './helpers.js';

export const migration014: Migration = {
  version: 14,
  name: 'container-configs',
  up(db: ICentralDb, ctx: MigrationContext) {
    const id = colId(ctx);
    const txt = colText(ctx);
    const json = colJson(ctx);
    const t = tableSuffix(ctx);
    db.exec(`
      CREATE TABLE container_configs (
        agent_group_id          ${id} PRIMARY KEY REFERENCES agent_groups(id) ON DELETE CASCADE,
        provider                ${txt},
        model                   ${txt},
        effort                  ${txt},
        image_tag               ${txt},
        assistant_name          ${txt},
        max_messages_per_prompt INTEGER,
        skills                  ${json} NOT NULL DEFAULT '"all"',
        mcp_servers             ${json} NOT NULL DEFAULT '{}',
        packages_apt            ${json} NOT NULL DEFAULT '[]',
        packages_npm            ${json} NOT NULL DEFAULT '[]',
        additional_mounts       ${json} NOT NULL DEFAULT '[]',
        updated_at              ${txt} NOT NULL
      )${t};
    `);
  },
};
