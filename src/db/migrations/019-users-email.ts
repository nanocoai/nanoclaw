import type { Migration } from './index.js';

/**
 * `email` on `users`: corporate email, set at provision time. The governance
 * service joins its Okta×Slack directory on it to resolve which policies bind to
 * a user, and the external provisioner persists it when creating the user.
 * NULL for users created outside provisioning. Indexed for the email lookup.
 */
export const migration019: Migration = {
  version: 19,
  name: 'users-email',
  async up(db) {
    await db.exec(`
      ALTER TABLE users ADD COLUMN email TEXT;
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    `);
  },
};
