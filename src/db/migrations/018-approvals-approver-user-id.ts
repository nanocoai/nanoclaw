import type { Migration } from './index.js';

/**
 * `approver_user_id` on `pending_approvals`: when an approval names a specific
 * approver (an a2a message-gate policy's approver), only that exact user may
 * resolve it. NULL keeps the existing group/owner authorization path.
 */
export const migration018: Migration = {
  version: 18,
  name: 'approvals-approver-user-id',
  up(db) {
    db.exec(`ALTER TABLE pending_approvals ADD COLUMN approver_user_id TEXT;`);
  },
};
