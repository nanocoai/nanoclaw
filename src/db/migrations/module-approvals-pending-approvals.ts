import type { Migration } from './index.js';

/**
 * `pending_approvals` table — host-side records for any approval-requiring
 * request. Used by:
 *   - install_packages / add_mcp_server  (session-bound, `session_id` set,
 *     status stays at default 'pending' until handled)
 *   - OneCLI credential approvals from the SDK `configureManualApproval`
 *     callback (session_id may be null, action='onecli_credential').
 *
 * The OneCLI-specific columns (`agent_group_id`, `channel_type`, `platform_id`,
 * `platform_message_id`, `expires_at`, `status`) let the host edit the admin
 * card when a request expires and sweep stale rows on startup.
 */
// Retains the original `name` ('pending-approvals') so existing DBs that
// already recorded this migration under that name don't re-run it. The
// module- prefix lives on the filename / export identifier only.
export const moduleApprovalsPendingApprovals: Migration = {
  version: 3,
  name: 'pending-approvals',
  sqliteOnly: true,
  up(db) {
    db.exec(`
      CREATE TABLE pending_approvals (
        approval_id         TEXT PRIMARY KEY,
        session_id          TEXT REFERENCES sessions(id),
        request_id          TEXT NOT NULL,
        action              TEXT NOT NULL,
        payload             TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        agent_group_id      TEXT REFERENCES agent_groups(id),
        channel_type        TEXT,
        platform_id         TEXT,
        platform_message_id TEXT,
        expires_at          TEXT,
        status              TEXT NOT NULL DEFAULT 'pending',
        title               TEXT NOT NULL DEFAULT '',
        options_json        TEXT NOT NULL DEFAULT '[]'
      );

      CREATE INDEX idx_pending_approvals_action_status
        ON pending_approvals(action, status);
    `);
  },
};
