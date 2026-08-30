import type { Migration } from './index.js';

/**
 * `provisioned_user_id` on `agent_groups`: the namespaced user id
 * (`slack:U123…`) the group was provisioned for. `groups create --spec` sets it
 * when a `user` is supplied; NULL for groups created outside provisioning.
 * Consumed by OneCLI credential-approval routing — a provisioned agent's
 * manual_approval cards go to this user first, admins stay as fallback.
 */
export const migration020: Migration = {
  version: 20,
  name: 'provisioned-user',
  async up(db) {
    await db.exec(`
      ALTER TABLE agent_groups ADD COLUMN provisioned_user_id TEXT;
    `);
  },
};
