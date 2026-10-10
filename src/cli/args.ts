/**
 * Canonical CLI arg keys: `--agent-group-id` and `--agent_group_id` are the
 * same flag. Dispatch canonicalizes once, before the group-scope auto-fill
 * and the guard, so the guard decides on exactly the keys and values the
 * handler will read.
 */
export function normalizeArgs(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('args must be an object');
  }
  const out: Record<string, unknown> = {};
  const seen = new Map<string, string>();
  for (const [key, value] of Object.entries(raw)) {
    const canonical = key.replace(/-/g, '_');
    // Assigning "__proto__" would swap the object's prototype, so handlers
    // could read keys the guard never saw.
    if (canonical === '__proto__') throw new Error(`flag --${key} is not allowed`);
    // Two spellings of one flag must agree; never let key order pick one.
    // (Frames queued for approval by older hosts can carry both, equal.)
    const prior = seen.get(canonical);
    if (prior !== undefined && !Object.is(out[canonical], value)) {
      throw new Error(`--${prior} and --${key} are the same flag; pass it once`);
    }
    seen.set(canonical, key);
    out[canonical] = value;
  }
  return out;
}
