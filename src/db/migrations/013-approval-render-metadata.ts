import type { ICentralDb } from '../central/types.js';
import type { Migration } from './index.js';
import { colJson, colText, hasColumn, type MigrationContext } from './helpers.js';

export const migration013: Migration = {
  version: 13,
  name: 'approval-render-metadata',
  up(db: ICentralDb, ctx: MigrationContext) {
    const txt = colText(ctx);
    const json = colJson(ctx);
    if (!hasColumn(db, ctx, 'pending_channel_approvals', 'title')) {
      db.exec(`ALTER TABLE pending_channel_approvals ADD COLUMN title ${txt} NOT NULL DEFAULT ''`);
    }
    if (!hasColumn(db, ctx, 'pending_channel_approvals', 'options_json')) {
      db.exec(`ALTER TABLE pending_channel_approvals ADD COLUMN options_json ${json} NOT NULL DEFAULT '[]'`);
    }
    if (!hasColumn(db, ctx, 'pending_sender_approvals', 'title')) {
      db.exec(`ALTER TABLE pending_sender_approvals ADD COLUMN title ${txt} NOT NULL DEFAULT ''`);
    }
    if (!hasColumn(db, ctx, 'pending_sender_approvals', 'options_json')) {
      db.exec(`ALTER TABLE pending_sender_approvals ADD COLUMN options_json ${json} NOT NULL DEFAULT '[]'`);
    }
  },
};
