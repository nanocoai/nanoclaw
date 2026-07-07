/**
 * Pure transforms that map OpenClaw config into NanoClaw v2 shapes.
 *
 * Two transforms, both deterministic and side-effect free so they can be
 * unit-tested in isolation (see transform.test.ts):
 *
 *   1. resolveSecretInput + classifyCredential — turn an OpenClaw config
 *      credential (plain string, "${ENV}" template, or SecretRef object) into
 *      a resolved value plus a routing decision: container-facing credentials
 *      go to the OneCLI vault (a `secrets create` plan); host-side channel
 *      tokens stay in `.env` (the NanoClaw host process reads them to connect
 *      to the messaging platform). Credentials are never threaded into a
 *      container via env vars.
 *
 *   2. mapCronToRecurrence — turn an OpenClaw cron job's `schedule` into the
 *      v2 task representation: a `messages_in` row with `kind='task'`, a
 *      `process_after` ISO timestamp (first run), and a `recurrence` cron
 *      expression for repeating jobs. There is no `scheduled_tasks` table in
 *      v2 — tasks live in the per-session `inbound.db`.
 */

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

/** OpenClaw SecretRef — a credential stored indirectly. */
export interface SecretRef {
  source: string; // "env" | "file" | "exec" | ...
  provider?: string;
  id: string;
}

export interface ResolvedSecret {
  /** The credential value, or null when it can't be auto-extracted. */
  resolved: string | null;
  /** How the value was sourced — for the status block / explanation. */
  source:
    | 'missing'
    | 'plain'
    | 'env_template'
    | 'env_ref'
    | 'file_ref'
    | 'exec_ref'
    | 'unknown';
  /** Human-readable note when a value couldn't be resolved. */
  note?: string;
}

/**
 * Resolve an OpenClaw credential input to a concrete string when possible.
 *
 * Accepts:
 *   - a plain literal:            "123:ABC-token"
 *   - an env template:            "${TELEGRAM_BOT_TOKEN}"
 *   - a SecretRef object:         { source: "env", id: "TELEGRAM_BOT_TOKEN" }
 *
 * `dotenvVars` is the parsed `<state-dir>/.env`; `processEnv` is consulted as
 * a fallback. `file`/`exec` SecretRefs can't be auto-extracted — they return
 * `resolved: null` with an explanatory note so the caller prompts the user.
 */
export function resolveSecretInput(
  value: unknown,
  dotenvVars: Record<string, string>,
  processEnv: Record<string, string | undefined> = {},
): ResolvedSecret {
  if (value === undefined || value === null || value === '') {
    return { resolved: null, source: 'missing' };
  }

  if (typeof value === 'string') {
    const envMatch = value.match(/^\$\{([^}]+)\}$/);
    if (envMatch) {
      const envKey = envMatch[1];
      const envVal = dotenvVars[envKey] ?? processEnv[envKey] ?? null;
      if (envVal) return { resolved: envVal, source: 'env_template' };
      return {
        resolved: null,
        source: 'env_template',
        note: `Environment variable ${envKey} not found in <state-dir>/.env or the environment`,
      };
    }
    return { resolved: value, source: 'plain' };
  }

  if (typeof value === 'object') {
    const ref = value as SecretRef;
    if (ref.source === 'env') {
      const envVal = dotenvVars[ref.id] ?? processEnv[ref.id] ?? null;
      if (envVal) return { resolved: envVal, source: 'env_ref' };
      return {
        resolved: null,
        source: 'env_ref',
        note: `Environment variable ${ref.id} not found in <state-dir>/.env or the environment`,
      };
    }
    if (ref.source === 'file') {
      return {
        resolved: null,
        source: 'file_ref',
        note: `File-based secret (${ref.id}) — cannot auto-extract, enter it manually`,
      };
    }
    if (ref.source === 'exec') {
      return {
        resolved: null,
        source: 'exec_ref',
        note: `Exec-based secret (${ref.id}) — cannot auto-extract, enter it manually`,
      };
    }
  }

  return { resolved: null, source: 'unknown' };
}

/** Mask a credential for display: first 4 + "..." + last 4. */
export function maskCredential(value: string): string {
  if (value.length < 10) return '****';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

/**
 * Where a resolved credential belongs in NanoClaw v2.
 *
 *   - 'vault'   → a container-facing credential the agent uses for outbound
 *                 HTTPS (Anthropic, OpenAI, etc.). It goes to the OneCLI Agent
 *                 Vault, which injects it per-request — never into the
 *                 container env. The plan field carries the `onecli secrets
 *                 create` argument set.
 *   - 'env'     → a host-side channel token (Telegram/Discord/Slack bot
 *                 tokens). The NanoClaw *host* process reads it from `.env` to
 *                 connect to the messaging platform; it never enters a
 *                 container, so the vault is not involved.
 */
export interface VaultPlan {
  /** `onecli secrets create --name` */
  name: string;
  /** `onecli secrets create --type` — 'anthropic' or 'api_key'. */
  type: 'anthropic' | 'api_key';
  /** `onecli secrets create --host-pattern` — the API host the agent calls. */
  hostPattern: string;
}

export interface CredentialDestination {
  destination: 'vault' | 'env';
  /** For 'env' destinations: the NanoClaw .env variable name. */
  envVar?: string;
  /** For 'vault' destinations: the `onecli secrets create` plan. */
  plan?: VaultPlan;
}

/**
 * Container-facing credentials → OneCLI vault. Keyed by a stable credential
 * kind the caller derives from the OpenClaw provider/profile (e.g. an
 * Anthropic auth profile, an OpenAI plugin key).
 */
const VAULT_CREDENTIALS: Record<string, VaultPlan> = {
  anthropic: { name: 'Anthropic', type: 'anthropic', hostPattern: 'api.anthropic.com' },
  openai: { name: 'OpenAI', type: 'api_key', hostPattern: 'api.openai.com' },
};

/**
 * Host-side channel tokens → NanoClaw `.env`. The host process (not the
 * container) reads these to connect to the messaging platform.
 */
const CHANNEL_ENV_VARS: Record<string, string[]> = {
  telegram: ['TELEGRAM_BOT_TOKEN'],
  discord: ['DISCORD_BOT_TOKEN'],
  slack: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'],
};

/**
 * Classify a credential by kind and decide its NanoClaw destination.
 *
 * `kind` is either a channel name (telegram/discord/slack) for a host-side
 * channel token, or a vault credential key (anthropic/openai) for a
 * container-facing API credential. `index` selects which env var for channels
 * that carry more than one token (Slack: bot + app).
 */
export function classifyCredential(
  kind: string,
  index = 0,
): CredentialDestination | null {
  const vault = VAULT_CREDENTIALS[kind];
  if (vault) {
    return { destination: 'vault', plan: vault };
  }
  const envVars = CHANNEL_ENV_VARS[kind];
  if (envVars && envVars[index]) {
    return { destination: 'env', envVar: envVars[index] };
  }
  return null;
}

/** Channel names whose host token is read from `.env` by the host process. */
export function channelEnvVars(channel: string): string[] {
  return CHANNEL_ENV_VARS[channel] ?? [];
}

/**
 * Render a OneCLI vault plan into the exact command the operator runs.
 * The credential value is passed through unmasked here because the caller
 * runs the command directly — it must never be echoed to a chat transcript.
 */
export function vaultCreateCommand(plan: VaultPlan, value: string): string {
  return [
    'onecli secrets create',
    `--name ${plan.name}`,
    `--type ${plan.type}`,
    `--value ${value}`,
    `--host-pattern ${plan.hostPattern}`,
  ].join(' ');
}

// ---------------------------------------------------------------------------
// Cron → v2 recurrence mapping
// ---------------------------------------------------------------------------

/** OpenClaw cron schedule shapes (from its `src/cron/types.ts`). */
export type OpenClawSchedule =
  | { kind: 'cron'; expr: string; tz?: string }
  | { kind: 'every'; everyMs: number }
  | { kind: 'at'; at: string };

/**
 * The v2 task shape. A task is a `messages_in` row with `kind='task'`:
 *
 *   - processAfter  → ISO 8601 timestamp for the first/next run.
 *   - recurrence    → cron expression for repeating tasks; null for one-shot.
 *
 * The host's recurrence sweep (src/modules/scheduling/recurrence.ts) reads the
 * cron in `recurrence`, computes the next run via cron-parser in the user's
 * timezone, and clones a fresh pending row forward. One-shot tasks have a null
 * recurrence and are marked completed after running.
 */
export interface V2TaskSchedule {
  processAfter: string;
  recurrence: string | null;
  /** Notes about anything that didn't map cleanly. */
  notes: string[];
}

/**
 * Map an OpenClaw schedule to the v2 task representation.
 *
 *   - kind:"cron"  → recurrence = expr; processAfter = next fire of expr.
 *                    Needs `computeNextCron` (cron-parser) injected so this
 *                    function stays pure / synchronously testable.
 *   - kind:"every" → recurrence = null; v2 has no fixed-interval recurrence,
 *                    so an interval is approximated as the nearest cron when
 *                    it divides evenly into minutes/hours, else flagged for
 *                    the user. processAfter = now + everyMs.
 *   - kind:"at"    → one-shot; recurrence = null; processAfter = the ISO `at`.
 *
 * `now` is injected (defaults to current time) for deterministic tests.
 */
export function mapCronToRecurrence(
  schedule: OpenClawSchedule,
  opts: {
    computeNextCron: (expr: string, tz?: string) => string;
    now?: number;
  },
): V2TaskSchedule {
  const now = opts.now ?? Date.now();
  const notes: string[] = [];

  if (schedule.kind === 'cron') {
    const processAfter = opts.computeNextCron(schedule.expr, schedule.tz);
    return { processAfter, recurrence: schedule.expr, notes };
  }

  if (schedule.kind === 'at') {
    return { processAfter: schedule.at, recurrence: null, notes };
  }

  // kind === 'every' — approximate a fixed interval as a cron expression.
  const everyMs = schedule.everyMs;
  const processAfter = new Date(now + everyMs).toISOString();
  const approx = approximateIntervalAsCron(everyMs);
  if (approx) {
    notes.push(
      `OpenClaw fixed interval (every ${everyMs}ms) approximated as cron "${approx}". v2 recurrence is cron-based; confirm this matches intent.`,
    );
    return { processAfter, recurrence: approx, notes };
  }
  notes.push(
    `OpenClaw fixed interval (every ${everyMs}ms) has no clean cron equivalent. Set a cron expression manually, or keep it one-shot.`,
  );
  return { processAfter, recurrence: null, notes };
}

/**
 * Approximate a millisecond interval as a cron expression when it lands on a
 * whole number of minutes or hours that divides evenly. Returns null when
 * there's no clean cron form (e.g. every 90 seconds).
 */
export function approximateIntervalAsCron(everyMs: number): string | null {
  if (everyMs <= 0) return null;
  const minutes = everyMs / 60000;
  if (!Number.isInteger(minutes) || minutes < 1) return null;

  if (minutes < 60) {
    // Every N minutes — only clean when N divides 60.
    if (60 % minutes === 0) return `*/${minutes} * * * *`;
    return null;
  }

  const hours = minutes / 60;
  if (Number.isInteger(hours)) {
    if (hours === 24) return '0 0 * * *';
    if (24 % hours === 0) return `0 */${hours} * * *`;
    return null;
  }

  return null;
}
