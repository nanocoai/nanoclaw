import type { Migration } from './index.js';

/**
 * Anchor flag for agent-shared session resolution on `sessions`.
 *
 * Without it, agent-shared wirings resolve to "newest active session in the
 * agent group" on every message — so creating any newer session (a new
 * shared-mode wiring, a recreated DM session) silently re-homes all
 * agent-shared traffic into it mid-conversation. The first agent-shared
 * resolution after this migration pins the session it lands on (exactly the
 * one pre-migration behavior would have picked, so nothing moves at
 * switch-on); later resolutions follow the pin. Deliberately no backfill:
 * groups with no agent-shared traffic never get an anchor row.
 */
export const migration020: Migration = {
  version: 20,
  name: 'agent-shared-anchor',
  up(db) {
    db.exec(`ALTER TABLE sessions ADD COLUMN agent_shared_anchor INTEGER NOT NULL DEFAULT 0;`);
  },
};
