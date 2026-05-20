import type { ICentralDb } from '../central/types.js';
import type { Migration } from './index.js';
import { colText, hasColumn, type MigrationContext } from './helpers.js';

export const migration015: Migration = {
  version: 15,
  name: 'cli-scope',
  up(db: ICentralDb, ctx: MigrationContext) {
    if (!hasColumn(db, ctx, 'container_configs', 'cli_scope')) {
      const txt = colText(ctx);
      db.exec(`ALTER TABLE container_configs ADD COLUMN cli_scope ${txt} NOT NULL DEFAULT 'group'`);
    }
  },
};
