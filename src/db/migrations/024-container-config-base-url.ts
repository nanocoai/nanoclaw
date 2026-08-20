import type { Migration } from './index.js';

/**
 * Per-agent-group model endpoint override on `container_configs`.
 *
 * NULL = call the provider's own default endpoint, which is what every
 * existing row does today — deliberately no backfill. A non-NULL value is a
 * validated absolute URL (HTTPS, or plain HTTP only for a loopback /
 * host.docker.internal address; rejected at the ncl write path and
 * re-validated on read in `configFromDb`) that says WHERE this group's
 * inference goes: a local Ollama daemon speaking Anthropic's `/v1/messages`,
 * a self-hosted gateway, a staging endpoint.
 *
 * One group, not the install: `.env`'s `ANTHROPIC_BASE_URL` (read by the
 * optional `claude` provider registration) already moves every claude group
 * at once, and that is the wrong granularity for "route this one agent at the
 * box under my desk".
 *
 * Effective on the group's next container spawn (`ncl groups restart`), like
 * every other container-config field.
 */
export const migration024: Migration = {
  version: 24,
  name: 'container-config-base-url',
  async up(db) {
    await db.exec(`ALTER TABLE container_configs ADD COLUMN base_url TEXT;`);
  },
};
