import type { ICentralDb } from '../central/types.js';
import type { Migration } from './index.js';
import { colId, colText, tableSuffix, type MigrationContext } from './helpers.js';

export const migration008: Migration = {
  version: 8,
  name: 'dropped-messages',
  up(db: ICentralDb, ctx: MigrationContext) {
    const id = colId(ctx);
    const txt = colText(ctx);
    const t = tableSuffix(ctx);
    db.exec(`
      CREATE TABLE IF NOT EXISTS unregistered_senders (
        channel_type       ${txt} NOT NULL,
        platform_id        ${txt} NOT NULL,
        user_id            ${id},
        sender_name        ${txt},
        reason             ${txt} NOT NULL,
        messaging_group_id ${id},
        agent_group_id     ${id},
        message_count      INTEGER NOT NULL DEFAULT 1,
        first_seen         ${txt} NOT NULL,
        last_seen          ${txt} NOT NULL,
        PRIMARY KEY (channel_type, platform_id)
      )${t};

      CREATE INDEX IF NOT EXISTS idx_unregistered_senders_last_seen
        ON unregistered_senders(last_seen);
    `);
  },
};
