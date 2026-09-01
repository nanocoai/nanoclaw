import type { Migration } from './index.js';

/**
 * Agent templates as central-database rows, so a stateless Host has a
 * template library that does not live on a node's disk.
 *
 * The folder library under `templates/` was the only registry, and it sat in
 * the host component's PRESERVE FLOOR (`templates/**`) so the seed script's
 * runtime-written template survived a redeploy. The same rule meant a template
 * a recipe shipped never reached the live tree: staged into the release, then
 * excluded from the sync, every deploy. The library was state on the node and
 * the deploy could not write to it — the wrong place to keep the one thing
 * provisioning starts from.
 *
 * A row is the whole template as a bundle (every file, text or base64), its
 * content digest, and which writer put it there. Types are plain TEXT so the
 * statement is the same on SQLite and PostgreSQL.
 */
export const migration026: Migration = {
  version: 26,
  name: 'agent-templates',
  async up(db) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS agent_templates (
        name TEXT PRIMARY KEY,
        digest TEXT NOT NULL,
        source TEXT NOT NULL,
        bundle TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  },
};
