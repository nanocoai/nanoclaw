/**
 * .env read/write helpers for the slack-agent-flow leg.
 *
 * Read semantics MUST stay compatible with src/env.ts readEnvFile (trimmed
 * lines, `#` comments, first `=` splits, matched surrounding quotes stripped,
 * empty values read as absent) — the adapter's SLACK_INSTANCES loop
 * (src/channels/slack.ts) reads back everything written here through that
 * parser. Write conventions mirror upsertEnvLine /
 * appendSlackInstance in .claude/skills/slack-managed-agents/scripts/
 * slack-create-agent.ts: replace the key's line in place, preserve every
 * other line (comments and blanks included), append with a clean trailing
 * newline.
 *
 * Values written here include live Slack tokens: never log values, only key
 * names. (No log calls exist in this file — keep it that way.)
 */
import fs from 'fs';
import path from 'path';

function envPath(rootDir: string): string {
  return path.join(rootDir, '.env');
}

function readEnvText(rootDir: string): string {
  try {
    return fs.readFileSync(envPath(rootDir), 'utf-8');
  } catch {
    return '';
  }
}

/** Parse one KEY from dotenv-style text with src/env.ts semantics. Last line wins. */
function parseEnvText(text: string, key: string): string | undefined {
  let result: string | undefined;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    if (trimmed.slice(0, eqIdx).trim() !== key) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result = value;
  }
  return result;
}

/** Process env first, then `${rootDir}/.env` — the same order everywhere. */
export function readEnvValue(rootDir: string, key: string): string | undefined {
  const fromEnv = process.env[key]?.trim();
  if (fromEnv) return fromEnv;
  return parseEnvText(readEnvText(rootDir), key);
}

/**
 * Replace KEY's line(s) in place, else append; creates .env when absent.
 * Every matching line is rewritten (not just the first) so the parser's
 * last-line-wins read can never resurface a stale value.
 */
export function upsertEnvKey(rootDir: string, key: string, value: string): void {
  const text = readEnvText(rootDir);
  const line = `${key}=${value}`;
  const lines = text.split('\n');
  let replaced = false;
  const next = lines.map((l) => {
    const trimmed = l.trim();
    if (trimmed.startsWith('#')) return l;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1 || trimmed.slice(0, eqIdx).trim() !== key) return l;
    replaced = true;
    return line;
  });
  const out = replaced ? next.join('\n') : text + (text.endsWith('\n') || text === '' ? '' : '\n') + line + '\n';
  fs.writeFileSync(envPath(rootDir), out);
}

/**
 * Set-union `entry` into KEY's comma-separated list (file value, not process
 * env — the list's readers parse .env only). Creates the key when absent.
 * Returns true iff the entry was newly added.
 */
export function appendToEnvList(rootDir: string, key: string, entry: string): boolean {
  const current = parseEnvText(readEnvText(rootDir), key);
  const entries = (current ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.includes(entry)) return false;
  upsertEnvKey(rootDir, key, [...entries, entry].join(','));
  return true;
}
