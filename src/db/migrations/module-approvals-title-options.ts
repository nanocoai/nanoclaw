import type { ICentralDb } from '../central/types.js';
import type { Migration } from './index.js';
import { colJson, colText, hasColumn, type MigrationContext } from './helpers.js';

export const moduleApprovalsTitleOptions: Migration = {
  version: 7,
  name: 'pending-approvals-title-options',
  up(db: ICentralDb, ctx: MigrationContext) {
    const txt = colText(ctx);
    const json = colJson(ctx);
    if (!hasColumn(db, ctx, 'pending_approvals', 'title')) {
      db.exec(`ALTER TABLE pending_approvals ADD COLUMN title ${txt} NOT NULL DEFAULT ''`);
    }
    if (!hasColumn(db, ctx, 'pending_approvals', 'options_json')) {
      db.exec(`ALTER TABLE pending_approvals ADD COLUMN options_json ${json} NOT NULL DEFAULT '[]'`);
    }
  },
};
