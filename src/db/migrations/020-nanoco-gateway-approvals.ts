import type { DbDriver } from '../driver.js';
import type { Migration } from './index.js';

export async function createGatewayApprovalsTable(db: DbDriver): Promise<void> {
  await db.exec(`
    CREATE TABLE nanoco_gateway_approvals (
      deployment_id           TEXT NOT NULL,
      gateway_epoch           TEXT NOT NULL,
      event_id                INTEGER,
      source_cursor           INTEGER NOT NULL,
      approval_id             TEXT NOT NULL,
      request_digest          TEXT NOT NULL,
      request_id              INTEGER NOT NULL,
      agent_id                TEXT NOT NULL,
      session_id              TEXT NOT NULL,
      container_instance_id   TEXT NOT NULL,
      channel_id              TEXT NOT NULL,
      deadline                TEXT NOT NULL,
      approver_issuer         TEXT NOT NULL,
      approver_subject        TEXT NOT NULL,
      policy_version          TEXT NOT NULL,
      matched_policy_ids_json TEXT NOT NULL,
      summary_method          TEXT NOT NULL,
      summary_origin          TEXT NOT NULL,
      summary_path            TEXT NOT NULL,
      presentation_json       TEXT NOT NULL,
      state                    TEXT NOT NULL CHECK (state IN ('pending', 'decided', 'delivered', 'expired', 'cancelled')),
      decision                 TEXT CHECK (decision IN ('approve', 'reject', 'unavailable')),
      approver_user_id         TEXT REFERENCES users(id),
      card_question_id         TEXT NOT NULL UNIQUE,
      card_title               TEXT NOT NULL,
      card_options_json        TEXT NOT NULL,
      card_channel_type        TEXT,
      card_platform_id         TEXT,
      card_instance            TEXT,
      card_attempted_at        TEXT,
      card_delivered_at        TEXT,
      card_platform_message_id TEXT,
      decision_at              TEXT,
      acknowledged_at          TEXT,
      gateway_state            TEXT CHECK (gateway_state IN ('approved', 'rejected', 'timed_out', 'cancelled')),
      created_at               TEXT NOT NULL,
      updated_at               TEXT NOT NULL,
      PRIMARY KEY (deployment_id, gateway_epoch, approval_id),
      UNIQUE (deployment_id, gateway_epoch, event_id)
    );

    CREATE INDEX idx_nanoco_gateway_approvals_retry
      ON nanoco_gateway_approvals(deployment_id, gateway_epoch, state, deadline);
  `);
}

/**
 * Durable NanoClaw state for Gateway-owned, request-scoped Ask approvals.
 *
 * These rows are delivery and decision evidence only. They are never a grant
 * and are deliberately separate from pending_approvals, whose approved rows
 * can continue a local privileged action.
 */
export const migration020: Migration = {
  version: 20,
  name: 'nanoco-gateway-approvals',
  async up(db) {
    await db.exec(`
      CREATE TABLE nanoco_approver_bindings (
        issuer     TEXT NOT NULL,
        subject    TEXT NOT NULL,
        user_id    TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        PRIMARY KEY (issuer, subject)
      );
    `);
    await createGatewayApprovalsTable(db);
    await db.exec(`
      CREATE TABLE nanoco_gateway_approval_cursors (
        deployment_id TEXT PRIMARY KEY,
        gateway_epoch TEXT NOT NULL,
        cursor        INTEGER NOT NULL,
        updated_at    TEXT NOT NULL
      );
    `);
  },
};
