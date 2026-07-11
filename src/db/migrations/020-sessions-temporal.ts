import type { Migration } from './index.js';

/**
 * `temporal` flag on `sessions`: marks an incognito/ephemeral session (the
 * `/incognito` DM command). When temporal=1 the session is excluded from all
 * normal routing/lifecycle lookups (findSessionForAgent, findSession, etc.) so
 * it coexists alongside the normal session for the same (group, mg, thread)
 * without colliding — there is no UNIQUE constraint on that triple. Its
 * container gets a fresh, memory-free workspace and is discarded on teardown.
 */
export const migration020: Migration = {
  version: 20,
  name: 'sessions-temporal',
  up(db) {
    db.exec(`ALTER TABLE sessions ADD COLUMN temporal INTEGER DEFAULT 0;`);
  },
};
