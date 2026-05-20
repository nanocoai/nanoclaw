import type { ICentralDb } from '../central/types.js';
import type { Migration } from './index.js';
import { colId, colLongText, colText, hasColumn, tableSuffix, type MigrationContext } from './helpers.js';

export const migration012: Migration = {
  version: 12,
  name: 'channel-registration',
  up(db: ICentralDb, ctx: MigrationContext) {
    const txt = colText(ctx);
    if (!hasColumn(db, ctx, 'messaging_groups', 'denied_at')) {
      db.exec(`ALTER TABLE messaging_groups ADD COLUMN denied_at ${txt}`);
    }

    const id = colId(ctx);
    const long = colLongText(ctx);
    const t = tableSuffix(ctx);
    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_channel_approvals (
        messaging_group_id ${id} PRIMARY KEY REFERENCES messaging_groups(id),
        agent_group_id     ${id} NOT NULL REFERENCES agent_groups(id),
        original_message   ${long} NOT NULL,
        approver_user_id   ${id} NOT NULL,
        created_at         ${txt} NOT NULL
      )${t};
    `);
  },
};
