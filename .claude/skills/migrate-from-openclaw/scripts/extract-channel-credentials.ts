/**
 * Extract a channel credential from an OpenClaw configuration and route it to
 * its correct NanoClaw v2 destination.
 *
 * Two destinations, decided per credential by transform.ts:
 *   - Host-side channel tokens (Telegram/Discord/Slack bot tokens) → written
 *     to NanoClaw's `.env`. The NanoClaw *host* process reads these to connect
 *     to the messaging platform; they never enter a container.
 *   - Container-facing API credentials (Anthropic, OpenAI, …) → NOT written
 *     anywhere by this script. The script prints the `onecli secrets create`
 *     command the operator runs so the credential lands in the OneCLI Agent
 *     Vault, which injects it per-request. Raw credentials are never threaded
 *     into a container env var.
 *
 * Usage:
 *   pnpm exec tsx .claude/skills/migrate-from-openclaw/scripts/extract-channel-credentials.ts \
 *     --channel telegram --state-dir ~/.openclaw [--write-env .env]
 *
 * Credential VALUES are never emitted to stdout — only masked versions. For
 * channel tokens, `--write-env` writes the real value directly to `.env` so
 * the agent never sees it. For vault credentials the script emits the plan
 * (name/type/host-pattern) but not the value; the operator runs the printed
 * command, keeping the secret off the chat transcript.
 *
 * Emits a status block on stdout:
 *   === NANOCLAW MIGRATE: CREDENTIAL ===
 *   ...
 *   === END ===
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  channelEnvVars,
  classifyCredential,
  maskCredential,
  resolveSecretInput,
} from './transform.js';

// ---------------------------------------------------------------------------
// JSON5-tolerant parser (OpenClaw config may use comments / trailing commas)
// ---------------------------------------------------------------------------

function parseJson5(text: string): unknown {
  let cleaned = text.replace(
    /("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g,
    (_match, str) => (str ? str : ''),
  );
  cleaned = cleaned.replace(
    /("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\//g,
    (_match, str) => (str ? str : ''),
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
// Channel → OpenClaw config field mapping
// ---------------------------------------------------------------------------

// The OpenClaw config field(s) that hold each channel's token. The matching
// NanoClaw .env destination is decided by classifyCredential() in transform.ts.
const CHANNEL_FIELDS: Record<string, string[]> = {
  telegram: ['botToken'],
  discord: ['token'],
  slack: ['botToken', 'appToken'],
  whatsapp: [], // QR/pairing-code auth — no token to migrate
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
    if (args[i] === '--channel' && args[i + 1]) channel = args[++i].toLowerCase();
    if (args[i] === '--state-dir' && args[i + 1]) stateDir = args[++i];
    if (args[i] === '--write-env' && args[i + 1]) writeEnv = args[++i];
  }

  if (!channel) {
    console.error('Usage: --channel <name> --state-dir <path> [--write-env <path>]');
    process.exit(1);
  }

  if (stateDir.startsWith('~')) {
    stateDir = path.join(os.homedir(), stateDir.slice(1));
  }

  if (!stateDir) {
    const home = os.homedir();
    if (fs.existsSync(path.join(home, '.openclaw'))) {
      stateDir = path.join(home, '.openclaw');
    } else if (fs.existsSync(path.join(home, '.clawdbot'))) {
      stateDir = path.join(home, '.clawdbot');
    } else {
      console.error('No OpenClaw directory found. Use --state-dir to specify.');
      process.exit(1);
    }
  }

  return { channel, stateDir, writeEnv };
}

// ---------------------------------------------------------------------------
// .env writer — appends or replaces a KEY=VALUE line (host-side tokens only)
// ---------------------------------------------------------------------------

function writeEnvVar(envPath: string, key: string, value: string): void {
  let content = '';
  if (fs.existsSync(envPath)) content = fs.readFileSync(envPath, 'utf-8');

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

  // WhatsApp uses QR / pairing-code auth — there is no token to migrate.
  // Copying Baileys auth state across installs leaves stale encryption
  // sessions, so re-authenticate during setup instead.
  if (channel === 'whatsapp') {
    emitStatus({
      CHANNEL: 'whatsapp',
      HAS_CREDENTIAL: false,
      DESTINATION: 'none',
      NOTE: 'WhatsApp authenticates via QR / pairing code — no token to migrate. Authenticate during /setup with /add-whatsapp.',
    });
    return;
  }

  const fields = CHANNEL_FIELDS[channel];
  if (!fields) {
    emitStatus({
      CHANNEL: channel,
      HAS_CREDENTIAL: false,
      DESTINATION: 'none',
      NOTE: `Channel "${channel}" has no direct token mapping. Supported: telegram, discord, slack, whatsapp.`,
    });
    return;
  }

  const dotenvVars = parseDotenv(path.join(stateDir, '.env'));

  let config: Record<string, unknown> | null = null;
  for (const name of ['openclaw.json', 'clawdbot.json']) {
    const configPath = path.join(stateDir, name);
    if (fs.existsSync(configPath)) {
      try {
        config = parseJson5(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
        break;
      } catch {
        // try next
      }
    }
  }

  if (!config) {
    emitStatus({ CHANNEL: channel, HAS_CREDENTIAL: false, NOTE: 'Could not load openclaw.json' });
    return;
  }

  const channels = (config.channels as Record<string, unknown> | undefined) ?? {};
  const channelConfig = (channels[channel] as Record<string, unknown> | undefined) ?? {};

  // Resolve every token field for this channel.
  const results: Array<{
    resolved: string | null;
    masked: string;
    source: string;
    note?: string;
    envVar: string;
  }> = [];

  const envVars = channelEnvVars(channel);

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];

    let rawValue = channelConfig[field];
    if (!rawValue && channelConfig.accounts) {
      const accounts = channelConfig.accounts as Record<string, unknown>;
      const firstAccount = Object.values(accounts)[0] as Record<string, unknown> | undefined;
      if (firstAccount) rawValue = firstAccount[field];
    }

    const { resolved, source, note } = resolveSecretInput(rawValue, dotenvVars, process.env);
    const dest = classifyCredential(channel, i);
    results.push({
      resolved,
      masked: resolved ? maskCredential(resolved) : '',
      source,
      note,
      envVar: dest?.envVar ?? envVars[i] ?? '',
    });
  }

  // Channel tokens are host-side: write them to .env when --write-env is set.
  let written = 0;
  if (writeEnv) {
    for (const r of results) {
      if (r.resolved && r.envVar) {
        writeEnvVar(writeEnv, r.envVar, r.resolved);
        written++;
      }
    }
  }

  const primary = results[0];
  const out: Record<string, string | number | boolean> = {
    CHANNEL: channel,
    DESTINATION: 'env',
    HAS_CREDENTIAL: !!primary.resolved,
    CREDENTIAL_SOURCE: primary.source,
    CREDENTIAL_MASKED: primary.masked || 'none',
    NANOCLAW_ENV_VAR: primary.envVar,
  };
  if (writeEnv && written > 0) {
    out.WRITTEN_TO = writeEnv;
    out.WRITTEN_COUNT = written;
  }
  if (primary.note) out.NOTE = primary.note;

  // Additional tokens (Slack carries bot + app).
  for (let i = 1; i < results.length; i++) {
    const extra = results[i];
    const suffix = `_${i + 1}`;
    out[`HAS_CREDENTIAL${suffix}`] = !!extra.resolved;
    out[`CREDENTIAL_SOURCE${suffix}`] = extra.source;
    out[`CREDENTIAL_MASKED${suffix}`] = extra.masked || 'none';
    out[`NANOCLAW_ENV_VAR${suffix}`] = extra.envVar;
    if (extra.note) out[`NOTE${suffix}`] = extra.note;
  }

  emitStatus(out);
}

main();
