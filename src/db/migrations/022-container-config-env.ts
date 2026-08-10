import type { Migration } from './index.js';

/**
 * Per-agent-group container env overrides and blocked hosts on
 * `container_configs`.
 *
 * Both NULL = no overrides, matching pre-migration behavior for every existing
 * row — deliberately no backfill.
 *
 * These exist so one agent group can be routed to a different model endpoint
 * than another (e.g. a local Ollama box) without redirecting the whole install.
 * The previous seam for that was `ANTHROPIC_BASE_URL` in `.env`, which the
 * claude provider applies to *every* group on that provider — fine for a
 * single-agent install, useless once one group must stay on the cloud API and
 * another must not reach it at all.
 *
 * `env` is JSON Record<string,string>; `blocked_hosts` is JSON string[], each
 * entry becoming `--add-host <host>:0.0.0.0` at spawn so the name resolves
 * nowhere from inside the container.
 */
export const migration022: Migration = {
  version: 22,
  name: 'container-config-env',
  up(db) {
    db.exec(`ALTER TABLE container_configs ADD COLUMN env TEXT;`);
    db.exec(`ALTER TABLE container_configs ADD COLUMN blocked_hosts TEXT;`);
  },
};
