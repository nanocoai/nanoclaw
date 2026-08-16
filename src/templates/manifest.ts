/**
 * plugin.json validation — the Agent Plugins 1.0.0 manifest.
 *
 * Hand-rolled against the published schema
 * (https://agent-plugins.org/schemas/1.0.0/plugin.schema.json), no new
 * dependency. The manifest is a closed object; the split the spec fixes:
 * unknown top-level fields and a non-object `extensions` are NON-fatal
 * (report + ignore, the forward-compatibility valve); every other schema
 * violation rejects the whole plugin.
 */
export const PLUGIN_SCHEMA_URL = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
export const MCP_SCHEMA_URL = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
export const PLUGIN_MANIFEST_FILE = 'plugin.json';

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  /** Namespace → payload. Foreign namespaces are kept but never validated. */
  extensions: Record<string, unknown>;
  /** Non-fatal notices (unknown fields, ignored extensions). */
  report: string[];
}

const STRING_FIELDS = ['version', 'description', 'homepage', 'repository', 'license'] as const;
const KNOWN_FIELDS = new Set(['$schema', 'name', 'author', 'keywords', 'extensions', ...STRING_FIELDS]);
const AUTHOR_FIELDS = new Set(['name', 'email', 'url']);

// Published schema pattern: lowercase alphanumerics, hyphens, periods; must
// start and end alphanumeric; no "--" or ".." runs; 1–64 chars.
const NAME_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

export function isValidPluginName(name: string): boolean {
  return name.length >= 1 && name.length <= 64 && NAME_RE.test(name) && !name.includes('--') && !name.includes('..');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate a parsed plugin.json document. Fatal violations throw. */
export function parsePluginManifest(raw: unknown): PluginManifest {
  if (!isPlainObject(raw)) throw new Error('plugin.json must be a JSON object');
  const report: string[] = [];

  if (raw.$schema !== PLUGIN_SCHEMA_URL) {
    throw new Error(`plugin.json $schema must be "${PLUGIN_SCHEMA_URL}"`);
  }
  if (typeof raw.name !== 'string' || !isValidPluginName(raw.name)) {
    throw new Error(
      'plugin.json name must be 1-64 chars of lowercase alphanumerics, hyphens, and periods, ' +
        'starting and ending alphanumeric, with no "--" or ".." runs',
    );
  }

  for (const field of STRING_FIELDS) {
    if (raw[field] !== undefined && typeof raw[field] !== 'string') {
      throw new Error(`plugin.json ${field} must be a string`);
    }
  }
  if (raw.keywords !== undefined) {
    if (!Array.isArray(raw.keywords) || !raw.keywords.every((k) => typeof k === 'string')) {
      throw new Error('plugin.json keywords must be an array of strings');
    }
  }
  if (raw.author !== undefined) {
    if (!isPlainObject(raw.author)) throw new Error('plugin.json author must be an object');
    for (const [key, value] of Object.entries(raw.author)) {
      if (!AUTHOR_FIELDS.has(key)) throw new Error(`plugin.json author has unknown field "${key}"`);
      if (typeof value !== 'string') throw new Error(`plugin.json author.${key} must be a string`);
    }
  }

  // Spec §4: non-object `extensions` is one of the two enumerated non-fatal
  // cases — report and ignore. Foreign namespace payloads are deliberately
  // NOT validated (spec §8: ignore namespaces you don't implement).
  let extensions: Record<string, unknown> = {};
  if (raw.extensions !== undefined) {
    if (isPlainObject(raw.extensions)) {
      extensions = raw.extensions;
    } else {
      report.push('plugin.json: extensions is not an object; ignored');
    }
  }

  for (const key of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(key)) report.push(`plugin.json: unknown field "${key}" ignored`);
  }

  return {
    name: raw.name,
    ...(typeof raw.version === 'string' ? { version: raw.version } : {}),
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    extensions,
    report,
  };
}
