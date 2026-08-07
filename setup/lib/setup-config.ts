/**
 * Setup-time advanced-config registry.
 *
 * One source of truth for: CLI flags, env-var names, the advanced-settings
 * screen, and `--help` output. The flag parser, env reader, and UI screen
 * all consume this list and write resolved values back to `process.env` so
 * existing step code keeps reading env vars unchanged.
 *
 * Default name conventions (overridable per entry):
 *   key 'fooBar' → envVar 'NANOCLAW_FOO_BAR' → flag '--foo-bar'
 *
 * Surface levels:
 *   'flag'     — CLI flag + env var only (debug/internal knobs)
 *   'flag+ui'  — also shown in the advanced-settings screen
 */

export type EntrySurface = 'flag' | 'flag+ui';

interface BaseEntry {
  /** Canonical camelCase key. */
  key: string;
  /** Override of the auto-derived NANOCLAW_<UPPER_SNAKE> env var. */
  envVar?: string;
  /** Override of the auto-derived --kebab-case flag. */
  flag?: string;
  label: string;
  help: string;
  surface: EntrySurface;
  /** UI section header. Entries without a group land in 'Other'. */
  group?: string;
  /** Mask in UI, redact in logs. */
  secret?: boolean;
}

interface StringEntry extends BaseEntry {
  type: 'string' | 'url';
  default?: string;
  placeholder?: string;
  validate?: (v: string) => string | undefined;
}

interface EnumEntry extends BaseEntry {
  type: 'enum';
  options: { value: string; label: string; hint?: string }[];
  default?: string;
}

interface BoolEntry extends BaseEntry {
  type: 'boolean';
  default?: boolean;
}

interface IntEntry extends BaseEntry {
  type: 'integer';
  default?: number;
  min?: number;
  max?: number;
}

export type Entry = StringEntry | EnumEntry | BoolEntry | IntEntry;

const httpUrl = (v: string): string | undefined =>
  /^https?:\/\/\S+/.test(v) ? undefined : 'Must be http(s)://…';

export const CONFIG: Entry[] = [
  {
    key: 'onecliApiHost',
    label: 'OneCLI vault URL',
    help: 'Use a remote OneCLI vault instead of installing one locally.',
    surface: 'flag+ui',
    group: 'OneCLI',
    type: 'url',
    default: 'https://api.onecli.sh',
    placeholder: 'https://api.onecli.sh',
    validate: httpUrl,
  },
  {
    key: 'onecliApiToken',
    label: 'OneCLI access token',
    help: 'Bearer token for the remote vault. Required if --onecli-api-host is set.',
    surface: 'flag+ui',
    group: 'OneCLI',
    type: 'string',
    secret: true,
    placeholder: 'oc_…',
    validate: (v) => (v.startsWith('oc_') ? undefined : 'Must start with oc_'),
  },
  {
    key: 'anthropicBaseUrl',
    label: 'Anthropic API base URL',
    help: 'Use a proxy or alternative endpoint instead of api.anthropic.com.',
    surface: 'flag+ui',
    group: 'Anthropic',
    type: 'url',
    placeholder: 'https://api.anthropic.com',
    validate: httpUrl,
  },
  {
    key: 'anthropicAuthToken',
    label: 'Anthropic auth token',
    help: 'Bearer token for the custom Anthropic endpoint. Used together with --anthropic-base-url.',
    surface: 'flag+ui',
    group: 'Anthropic',
    type: 'string',
    secret: true,
    validate: (v) => (v.trim() ? undefined : 'Required'),
  },

  // Existing env-var knobs — flag-only so they don't clutter the UI screen.
  {
    key: 'skip',
    envVar: 'NANOCLAW_SKIP',
    label: 'Skip steps',
    help: 'Comma-separated step names to skip (debugging only).',
    surface: 'flag',
    type: 'string',
  },
  {
    key: 'displayName',
    envVar: 'NANOCLAW_DISPLAY_NAME',
    label: 'Display name',
    help: 'Skip the "what should your assistant call you?" prompt.',
    surface: 'flag',
    type: 'string',
  },
  {
    key: 'agentProvider',
    envVar: 'NANOCLAW_AGENT_PROVIDER',
    label: 'Agent provider',
    help: 'Preselect the setup provider and skip the provider picker.',
    surface: 'flag',
    type: 'string',
  },
  {
    key: 'assistMode',
    envVar: 'NANOCLAW_SETUP_ASSIST_MODE',
    label: 'Assist mode',
    help: 'Use non-interactive Claude assist on failure instead of interactive handoff.',
    surface: 'flag',
    type: 'boolean',
    default: false,
  },

  // Uninstall route — handled in auto.ts before any setup work begins.
  {
    key: 'uninstall',
    label: 'Uninstall',
    help: 'Remove this NanoClaw copy (service, containers, data, vault agents). Asks per group.',
    surface: 'flag',
    type: 'boolean',
    default: false,
  },
  {
    key: 'dryRun',
    label: 'Uninstall dry run',
    help: 'With --uninstall: preview what would be removed without changing anything.',
    surface: 'flag',
    type: 'boolean',
    default: false,
  },
  {
    key: 'yes',
    label: 'Uninstall without prompts',
    help: 'With --uninstall: delete everything found without asking (orphan vault agents are still kept).',
    surface: 'flag',
    type: 'boolean',
    default: false,
  },
];

// ─── name derivation ───────────────────────────────────────────────────

export function envVarFor(e: Entry): string {
  if (e.envVar) return e.envVar;
  return `NANOCLAW_${e.key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
}

export function flagFor(e: Entry): string {
  if (e.flag) return e.flag;
  return `--${e.key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

export function findByFlag(flag: string): Entry | null {
  return CONFIG.find((e) => flagFor(e) === flag) ?? null;
}
