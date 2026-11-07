/**
 * Extra per-task fields carried in the task content envelope.
 *
 * An install registers a field once (flag, content key, parser) and it becomes
 * a `ncl tasks create` / `update` flag, is merged into the content JSON on
 * partial updates, and shows up in `ncl tasks get`. The container receives the
 * whole envelope on each fire, so consumers read `content[contentKey]` there.
 * With nothing registered, tasks behave exactly as before.
 */

export interface TaskFieldDef {
  /** CLI flag name in underscore form: `script_timeout` → `--script-timeout`. */
  flag: string;
  /** Key the parsed value is stored under in the task content JSON. */
  contentKey: string;
  /** How the CLI coerces the raw flag before `parse` sees it. Defaults to `string`. */
  type?: 'string' | 'number' | 'boolean';
  description: string;
  /** Validate and normalize the coerced flag value. Throw to reject. */
  parse?: (raw: unknown) => unknown;
}

const CORE_CONTENT_KEYS = new Set(['prompt', 'script', 'originSessionId', 'scriptOutput']);
const CORE_FLAGS = new Set([
  'id',
  'name',
  'prompt',
  'recurrence',
  'process_after',
  'script',
  'group',
  'agent_group_id',
  'session',
  'status',
  'all',
  'msg',
  'help',
  'dangerously_override_recurrence_limit',
]);

const fields = new Map<string, TaskFieldDef>();

/** Register an extra task field. Returns a function that removes it again. */
export function registerTaskField(def: TaskFieldDef): () => void {
  if (CORE_FLAGS.has(def.flag)) throw new Error(`task field flag is reserved: ${def.flag}`);
  if (CORE_CONTENT_KEYS.has(def.contentKey)) throw new Error(`task field content key is reserved: ${def.contentKey}`);
  if (fields.has(def.flag)) throw new Error(`task field already registered: ${def.flag}`);
  for (const other of fields.values()) {
    if (other.contentKey === def.contentKey)
      throw new Error(`task field content key already registered: ${def.contentKey}`);
  }
  fields.set(def.flag, def);
  return () => {
    if (fields.get(def.flag) === def) fields.delete(def.flag);
  };
}

export function getTaskFields(): TaskFieldDef[] {
  return [...fields.values()];
}

/** Parse the registered flags present in `args` into `{ contentKey: value }`. */
export function parseTaskFields(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const def of fields.values()) {
    const raw = args[def.flag];
    if (raw === undefined) continue;
    out[def.contentKey] = def.parse ? def.parse(raw) : raw;
  }
  return out;
}

/** Read the registered fields back out of a stored content envelope, keyed by flag. */
export function readTaskFields(rawContent: string): Record<string, unknown> {
  if (fields.size === 0) return {};
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(rawContent);
    if (value && typeof value === 'object') parsed = value as Record<string, unknown>;
    // eslint-disable-next-line no-catch-all/no-catch-all -- LEGACY-COMPAT(v1-tasks): plain-string content predating the JSON envelope
  } catch {
    // no envelope, so no extra fields
  }
  const out: Record<string, unknown> = {};
  for (const def of fields.values()) out[def.flag] = parsed[def.contentKey] ?? null;
  return out;
}
