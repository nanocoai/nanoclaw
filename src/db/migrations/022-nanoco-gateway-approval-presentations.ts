import type { Migration } from './index.js';
import { createGatewayApprovalsTable } from './020-nanoco-gateway-approvals.js';

/**
 * Protocol v2 intentionally starts a fresh Gateway approval epoch. Existing
 * bridge rows contain the v1 body preview rather than the bounded typed
 * presentation, so they cannot be upgraded truthfully. Replace only that
 * bridge state; approver bindings and every unrelated host table remain.
 */
export const migration022: Migration = {
  version: 22,
  name: 'nanoco-gateway-approval-presentations',
  async up(db) {
    if (!db.columnOwners) throw new Error('central DB driver cannot inspect migration columns');
    const presentationOwners = await db.columnOwners('presentation_json');
    const previewOwners = await db.columnOwners('summary_body_preview');

    if (presentationOwners.includes('nanoco_gateway_approvals')) return;
    if (!previewOwners.includes('nanoco_gateway_approvals')) {
      throw new Error('nanoco_gateway_approvals has neither the v1 nor v2 presentation column');
    }

    await db.exec(`
      DROP TABLE nanoco_gateway_approvals;
      DELETE FROM nanoco_gateway_approval_cursors;
    `);
    await createGatewayApprovalsTable(db);
  },
};
