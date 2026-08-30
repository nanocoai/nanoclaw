import type { Migration } from './index.js';

/**
 * `onecli_project_id` on `users`: the OneCLI project provisioned for this user,
 * giving them credential isolation (their own app connections / secrets) under
 * the host's single org API key. Set by the external provisioner;
 * NULL until then (falls back to the host-wide ONECLI_PROJECT_ID at spawn).
 */
export const migration021: Migration = {
  version: 21,
  name: 'user-onecli-project',
  async up(db) {
    await db.exec(`
      ALTER TABLE users ADD COLUMN onecli_project_id TEXT;
    `);
  },
};
