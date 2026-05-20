import type { ICentralDb } from '../central/types.js';
import type { Migration } from './index.js';
import { colId, colLongText, colText, tableSuffix, type MigrationContext } from './helpers.js';

export const migration011: Migration = {
  version: 11,
  name: 'pending-sender-approvals',
  up(db: ICentralDb, ctx: MigrationContext) {
    const id = colId(ctx);
    const txt = colText(ctx);
    const long = colLongText(ctx);
    const t = tableSuffix(ctx);
    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_sender_approvals (
        id                 ${id} PRIMARY KEY,
        messaging_group_id ${id} NOT NULL REFERENCES messaging_groups(id),
        agent_group_id     ${id} NOT NULL REFERENCES agent_groups(id),
        sender_identity    ${txt} NOT NULL,
        sender_name        ${txt},
        original_message   ${long} NOT NULL,
        approver_user_id   ${id} NOT NULL,
        created_at         ${txt} NOT NULL,
        UNIQUE(messaging_group_id, sender_identity)
      )${t};
      CREATE INDEX IF NOT EXISTS idx_pending_sender_approvals_mg
        ON pending_sender_approvals(messaging_group_id);
    `);
  },
};
