/**
 * Internet-access policy field.
 *
 * Adds an opaque column that core writes nothing to and reads nothing
 * from — it exists so a registered `NetworkPolicyProvider` (skill) has
 * a place to persist per-agent outbound-internet policy without adding
 * its own table.
 *
 *   - `agent_groups.internet_access_policy` (TEXT, nullable) — JSON blob;
 *     the provider's per-agent policy descriptor (e.g. WAN bucket, ACL
 *     list).
 *
 * Inter-agent directionality is intentionally not modeled here:
 * `agent_destinations` rows are already one-way grants (one row per
 * direction), so absence of the inverse row encodes "the target cannot
 * reply via this mechanism." Any stateful semantics a future provider
 * might want (e.g. time-windowed reply grants) belong in a provider-
 * owned table, not on the destination row.
 *
 * Backward-compat: existing `agent_groups` rows get `NULL` (no policy
 * configured). With no provider registered, the column influences no
 * code path.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migrationInternetAccessPolicy: Migration = {
  version: 14,
  name: 'internet-access-policy-field',
  up(db: Database.Database) {
    db.exec(`ALTER TABLE agent_groups ADD COLUMN internet_access_policy TEXT`);
  },
};
