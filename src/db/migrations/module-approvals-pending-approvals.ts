import type { ICentralDb } from '../central/types.js';
import type { Migration } from './index.js';
import { colId, colJson, colLongText, colText, tableSuffix, type MigrationContext } from './helpers.js';

export const moduleApprovalsPendingApprovals: Migration = {
  version: 3,
  name: 'pending-approvals',
  up(db: ICentralDb, ctx: MigrationContext) {
    const id = colId(ctx);
    const txt = colText(ctx);
    const long = colLongText(ctx);
    const json = colJson(ctx);
    const t = tableSuffix(ctx);
    db.exec(`
      CREATE TABLE pending_approvals (
        approval_id         ${id} PRIMARY KEY,
        session_id          ${id} REFERENCES sessions(id),
        request_id          ${id} NOT NULL,
        action              ${txt} NOT NULL,
        payload             ${long} NOT NULL,
        created_at          ${txt} NOT NULL,
        agent_group_id      ${id} REFERENCES agent_groups(id),
        channel_type        ${txt},
        platform_id         ${txt},
        platform_message_id ${txt},
        expires_at          ${txt},
        status              ${txt} NOT NULL DEFAULT 'pending',
        title               ${txt} NOT NULL DEFAULT '',
        options_json        ${json} NOT NULL DEFAULT '[]'
      )${t};

      CREATE INDEX idx_pending_approvals_action_status
        ON pending_approvals(action, status);
    `);
  },
};
