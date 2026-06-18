/**
 * Generic migrate-v2 post-seed step registry (core extension contract).
 *
 * The v1->v2 migration (`setup/migrate-v2/db.ts`) seeds agent_groups,
 * messaging_groups and wirings from v1's registered_groups. Some installs need
 * to run extra carry-over work AFTER that seed loop — e.g. the TaskFlow overlay
 * carries v1 `registered_groups.is_main=1` over to v2
 * `messaging_groups.is_main_control=1`. That logic is fork-private, so core
 * ships this registry EMPTY and the overlay registers a step.
 *
 * Wiring: `db.ts` imports `./migrate-v2-steps-register.js` for side effects (the
 * install-overlay append point); each overlay step module calls
 * `registerMigrateV2Step(...)` at import time. Mirrors the other split
 * registries (startup-registry, container-contributor-registry): name-keyed,
 * throws on duplicate, runs in registration order. Pristine core registers
 * zero steps, so the migration runs unchanged.
 */

/** A messaging group successfully created/reused during the seed loop. */
export interface MigratedGroup {
  folder: string;
  messagingGroupId: string;
  /** v1 registered_groups.is_main for this row. */
  v1IsMain: boolean;
}

/** A v1 group that was skipped during the seed loop (parse/resolve/error). */
export interface SkippedGroup {
  folder: string;
  jid: string;
  reason: string;
  /** v1 registered_groups.is_main for this row. */
  v1IsMain: boolean;
}

/** Read-only view of the seed loop's outcome, passed to each step. */
export interface MigrateV2Context {
  migrated: MigratedGroup[];
  skipped: SkippedGroup[];
}

/**
 * A post-seed step. May return `key=value` summary fragments that `db.ts`
 * appends to its `OK:` line (e.g. `main_promoted=1`), or nothing.
 */
export type MigrateV2Step = (ctx: MigrateV2Context) => string[] | void | Promise<string[] | void>;

const steps = new Map<string, MigrateV2Step>();

export function registerMigrateV2Step(name: string, fn: MigrateV2Step): void {
  if (steps.has(name)) {
    throw new Error(`migrate-v2 step "${name}" already registered`);
  }
  steps.set(name, fn);
}

/** Run every registered step in registration order; collect their summary fields. */
export async function runMigrateV2Steps(ctx: MigrateV2Context): Promise<string[]> {
  const fields: string[] = [];
  for (const [, fn] of steps) {
    const out = await fn(ctx);
    if (Array.isArray(out)) fields.push(...out);
  }
  return fields;
}
