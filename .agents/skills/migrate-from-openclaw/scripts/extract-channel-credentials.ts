/**
 * Extract a channel credential from an OpenClaw configuration and write it
 * directly to the NanoClaw .env file.
 *
 * Usage: pnpm exec tsx .claude/skills/migrate-from-openclaw/scripts/extract-channel-credentials.ts \
 *          --channel telegram --state-dir ~/.openclaw --write-env .env
 *
 * Handles OpenClaw SecretRef formats:
 *   - Plain string: "bot-token-value"
 *   - Env template: "${TELEGRAM_BOT_TOKEN}"
 *   - SecretRef object: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" }
 *
 * Also reads <state-dir>/.env for env-based secrets.
 *
 * Credential values are NEVER emitted to stdout — only masked versions.
 * When --write-env is provided, the script writes credentials directly to
 * the target .env file so the agent never sees raw secrets.
 *
 * Emits a status block on stdout:
 *   === NANOCLAW MIGRATE: CREDENTIAL ===
 *   ...
 *   === END ===
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

// ---------------------------------------------------------------------------
// JSON5-tolerant parser (same as discover script)
// ---------------------------------------------------------------------------

function parseJson5(text: string): unknown {
  let cleaned = text.replace(
    /("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g,
    (match, str) => (str ? str : ''),
  );
  cleaned = cleaned.replace(
    /("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\//g,
    (match, str) => (str ? str : ''),
  );
  cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(cleaned);
}

// ---------------------------------------------------------------------------
// Inline dotenv parser (reads key=value, skips comments)
// ---------------------------------------------------------------------------

function parseDotenv(filePath: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!fs.existsSync(filePath)) return env;

  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Status block emitter
// ---------------------------------------------------------------------------

function emitStatus(fields: Record<string, string | number | boolean>): void {
  const lines = ['=== NANOCLAW MIGRATE: CREDENTIAL ==='];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key}: ${value}`);
  }
  lines.push('=== END ===');
  console.log(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Credential masking
// ---------------------------------------------------------------------------

function maskCredential(value: string): string {
  if (value.length < 10) return '****';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// SecretRef resolution
// ---------------------------------------------------------------------------

interface SecretRef {
  source: string;
  provider?: string;
  id: string;
}

function resolveSecretInput(
  value: unknown,
  dotenvVars: Record<string, string>,
): { resolved: string | null; source: string; note?: string } {
  if (!value) return { resolved: null, source: 'missing' };

  // Plain string
  if (typeof value === 'string') {
    // Check for env template: "${VAR_NAME}"
    const envMatch = value.match(/^\$\{([^}]+)\}$/);
    if (envMatch) {
      const envKey = envMatch[1];
      const envVal =
        dotenvVars[envKey] ?? process.env[envKey] ?? null;
      if (envVal) {
        return { resolved: envVal, source: 'env_template' };
      }
      return {
        resolved: null,
        source: 'env_template',
        note: `Environment variable ${envKey} not found`,
      };
    }

    // Plain literal value
    return { resolved: value, source: 'plain' };
  }

  // SecretRef object
  if (typeof value === 'object' && value !== null) {
    const ref = value as SecretRef;
    if (ref.source === 'env') {
      const envVal =
        dotenvVars[ref.id] ?? process.env[ref.id] ?? null;
      if (envVal) {
        return { resolved: envVal, source: 'env_ref' };
      }
      return {
        resolved: null,
        source: 'env_ref',
        note: `Environment variable ${ref.id} not found`,
      };
    }
    if (ref.source === 'file') {
      return {
        resolved: null,
        source: 'file_ref',
        note: `File-based secret (${ref.id}) — cannot auto-extract, add manually`,
      };
    }
    if (ref.source === 'exec') {
      return {
        resolved: null,
        source: 'exec_ref',
        note: `Exec-based secret (${ref.id}) — cannot auto-extract, add manually`,
      };
    }
  }

  return { resolved: null, source: 'unknown' };
}

// ---------------------------------------------------------------------------
// Channel credential mapping
// ---------------------------------------------------------------------------

interface ChannelCredentialSpec {
  // Fields to look for in the channel config
  fields: string[];
  // Corresponding NanoClaw env var names
  envVars: string[];
}

const CHANNEL_SPECS: Record<string, ChannelCredentialSpec> = {
  telegram: {
    fields: ['botToken'],
    envVars: ['TELEGRAM_BOT_TOKEN'],
  },
  discord: {
    fields: ['token'],
    envVars: ['DISCORD_BOT_TOKEN'],
  },
  slack: {
    fields: ['botToken', 'appToken'],
    envVars: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'],
  },
  whatsapp: {
    fields: [], // Auth-state based, no token field
    envVars: [],
  },
};

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgs(): { channel: string; stateDir: string; writeEnv: string } {
  const args = process.argv.slice(2);
  let channel = '';
  let stateDir = '';
  let writeEnv = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--channel' && args[i + 1]) {
      channel = args[++i].toLowerCase();
    }
    if (args[i] === '--state-dir' && args[i + 1]) {
      stateDir = args[++i];
    }
    if (args[i] === '--write-env' && args[i + 1]) {
      writeEnv = args[++i];
    }
  }

  if (!channel) {
    console.error('Usage: --channel <name> --state-dir <path> [--write-env <path>]');
    process.exit(1);
  }

  // Expand ~ prefix
  if (stateDir.startsWith('~')) {
    stateDir = path.join(os.homedir(), stateDir.slice(1));
  }

  // Default state dir
  if (!stateDir) {
    const home = os.homedir();
    if (fs.existsSync(path.join(home, '.openclaw'))) {
      stateDir = path.join(home, '.openclaw');
    } else if (fs.existsSync(path.join(home, '.clawdbot'))) {
      stateDir = path.join(home, '.clawdbot');
    } else {
      console.error(
        'No OpenClaw directory found. Use --state-dir to specify.',
      );
      process.exit(1);
    }
  }

  return { channel, stateDir, writeEnv };
}

// ---------------------------------------------------------------------------
// .env writer — appends or replaces a KEY=VALUE line
// ---------------------------------------------------------------------------

function writeEnvVar(envPath: string, key: string, value: string): void {
  let content = '';
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf-8');
  }

  const pattern = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}="${value}"`;

  if (pattern.test(content)) {
    content = content.replace(pattern, line);
  } else {
    content = content.trimEnd() + (content ? '\n' : '') + line + '\n';
  }

  fs.writeFileSync(envPath, content);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const { channel, stateDir, writeEnv } = parseArgs();
  const spec = CHANNEL_SPECS[channel];

  // Load dotenv from state dir
  const dotenvVars = parseDotenv(path.join(stateDir, '.env'));

  // Also check auth-profiles.json for API keys
  const authProfilesPath = path.join(stateDir, 'auth-profiles.json');
  let authProfiles: Record<string, unknown> = {};
  if (fs.existsSync(authProfilesPath)) {
    try {
      authProfiles = JSON.parse(
        fs.readFileSync(authProfilesPath, 'utf-8'),
      ) as Record<string, unknown>;
    } catch {
      // Ignore parse errors
    }
  }

  // WhatsApp special case: no token, auth-state based.
  // OpenClaw stores Baileys auth at <stateDir>/credentials/whatsapp/<accountId>/
  // using useMultiFileAuthState (same as NanoClaw). The files are directly compatible.
  if (channel === 'whatsapp') {
    const authPaths = [
      path.join(stateDir, 'credentials', 'whatsapp', 'default'),
      path.join(stateDir, 'credentials', 'whatsapp'),
      path.join(stateDir, 'wa-auth'),
    ];

    // Also scan credentials/whatsapp/ for any account subdirectory
    const waCredsDir = path.join(stateDir, 'credentials', 'whatsapp');
    if (fs.existsSync(waCredsDir)) {
      try {
        for (const entry of fs.readdirSync(waCredsDir)) {
          const candidate = path.join(waCredsDir, entry);
          if (fs.statSync(candidate).isDirectory()) {
            authPaths.push(candidate);
          }
        }
      } catch {
        // ignore
      }
    }
    let authStatePath = '';
    for (const p of authPaths) {
      // Look for creds.json inside the directory — that confirms valid Baileys auth state
      if (fs.existsSync(path.join(p, 'creds.json'))) {
        authStatePath = p;
        break;
      }
    }

    emitStatus({
      CHANNEL: 'whatsapp',
      HAS_CREDENTIAL: false,
      CREDENTIAL_SOURCE: 'auth_state',
      NOTE: authStatePath
        ? `Baileys auth state found at ${authStatePath}. May not be portable across versions — recommend re-authenticating.`
        : 'No WhatsApp auth state found. Will need to authenticate during setup.',
      AUTH_STATE_PATH: authStatePath || 'not_found',
    });
    return;
  }

  // Unknown channel
  if (!spec) {
    emitStatus({
      CHANNEL: channel,
      HAS_CREDENTIAL: false,
      NOTE: `Channel "${channel}" is not supported by NanoClaw. Supported: telegram, discord, slack, whatsapp.`,
    });
    return;
  }

  // Load OpenClaw config
  let config: Record<string, unknown> | null = null;
  for (const name of ['openclaw.json', 'clawdbot.json']) {
    const configPath = path.join(stateDir, name);
    if (fs.existsSync(configPath)) {
      try {
        config = parseJson5(
          fs.readFileSync(configPath, 'utf-8'),
        ) as Record<string, unknown>;
        break;
      } catch {
        // Try next
      }
    }
  }

  if (!config) {
    emitStatus({
      CHANNEL: channel,
      HAS_CREDENTIAL: false,
      NOTE: 'Could not load openclaw.json',
    });
    return;
  }

  const channels =
    (config.channels as Record<string, unknown> | undefined) ?? {};
  const channelConfig =
    (channels[channel] as Record<string, unknown> | undefined) ?? {};

  // Try to resolve each credential field
  const results: Array<{
    envVar: string;
    resolved: string | null;
    masked: string;
    source: string;
    note?: string;
  }> = [];

  for (let i = 0; i < spec.fields.length; i++) {
    const field = spec.fields[i];
    const envVar = spec.envVars[i];

    // Check top-level channel config first
    let rawValue = channelConfig[field];

    // If not found, check first account
    if (!rawValue && channelConfig.accounts) {
      const accounts = channelConfig.accounts as Record<string, unknown>;
      const firstAccount = Object.values(accounts)[0] as
        | Record<string, unknown>
        | undefined;
      if (firstAccount) {
        rawValue = firstAccount[field];
      }
    }

    const { resolved, source, note } = resolveSecretInput(
      rawValue,
      dotenvVars,
    );
    results.push({
      envVar,
      resolved,
      masked: resolved ? maskCredential(resolved) : '',
      source,
      note,
    });
  }

  // Emit results for the primary credential
  const primary = results[0];
  if (!primary) {
    emitStatus({
      CHANNEL: channel,
      HAS_CREDENTIAL: false,
      NOTE: `No credential fields defined for ${channel}`,
    });
    return;
  }

  // If --write-env is set and credentials were resolved, write directly to .env.
  // Credential values never appear in stdout.
  let written = 0;
  if (writeEnv) {
    for (const r of results) {
      if (r.resolved) {
        writeEnvVar(writeEnv, r.envVar, r.resolved);
        written++;
      }
    }
  }

  const fields: Record<string, string | number | boolean> = {
    CHANNEL: channel,
    HAS_CREDENTIAL: !!primary.resolved,
    CREDENTIAL_SOURCE: primary.source,
    CREDENTIAL_MASKED: primary.masked || 'none',
    NANOCLAW_ENV_VAR: primary.envVar,
  };

  if (writeEnv && written > 0) {
    fields.WRITTEN_TO = writeEnv;
    fields.WRITTEN_COUNT = written;
  }
  if (primary.note) {
    fields.NOTE = primary.note;
  }

  // Additional credentials (e.g. Slack has botToken + appToken)
  if (results.length > 1) {
    for (let i = 1; i < results.length; i++) {
      const extra = results[i];
      const suffix = `_${i + 1}`;
      fields[`HAS_CREDENTIAL${suffix}`] = !!extra.resolved;
      fields[`CREDENTIAL_SOURCE${suffix}`] = extra.source;
      fields[`CREDENTIAL_MASKED${suffix}`] = extra.masked || 'none';
      fields[`NANOCLAW_ENV_VAR${suffix}`] = extra.envVar;
      if (extra.note) {
        fields[`NOTE${suffix}`] = extra.note;
      }
    }
  }

  emitStatus(fields);
}

main();
