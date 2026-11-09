/**
 * Headless Claude fallback for timezone resolution.
 *
 * When the user answers the UTC-confirmation prompt with something that
 * isn't a valid IANA zone ("NYC", "Jerusalem time", "eastern"), spawn
 * `claude -p` with a narrow prompt asking for a single IANA string and
 * validate the reply with `isValidTimezone` before returning it.
 *
 * Gated on claude being on PATH — if the user did the paste-OAuth or
 * paste-API auth path they may not have the CLI installed. Returns null
 * in that case so the caller can ask them to try again with a canonical
 * zone string.
 */
import { execSync, spawn } from 'child_process';

import * as p from '@clack/prompts';
import k from 'kleur';

import { isValidTimezone } from '../../src/timezone.js';
import { fitToWidth, fmtDuration } from './theme.js';

export function claudeCliAvailable(): boolean {
  try {
    execSync('command -v claude', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask headless Claude to map a free-text location/timezone description to
 * a valid IANA zone. Shows a spinner with elapsed time. Returns the
 * resolved zone string on success, or null if the CLI is missing, Claude
 * errored, or the reply wasn't a valid IANA zone.
 */
export async function resolveTimezoneViaClaude(input: string): Promise<string | null> {
  if (!claudeCliAvailable()) return null;

  const prompt = buildPrompt(input);

  const s = p.spinner();
  const start = Date.now();
  const label = 'Looking up that timezone…';
  s.start(fitToWidth(label, ' (99m 59s)'));
  const tick = setInterval(() => {
    const suffix = ` (${fmtDuration(Date.now() - start)})`;
    s.message(`${fitToWidth(label, suffix)}${k.dim(suffix)}`);
  }, 1000);

  const reply = await queryClaude(prompt);

  clearInterval(tick);
  const suffix = ` (${fmtDuration(Date.now() - start)})`;

  const resolved = reply ? extractTimezone(reply) : null;
  if (resolved) {
    s.stop(`${fitToWidth(`Interpreted as ${resolved}.`, suffix)}${k.dim(suffix)}`);
    return resolved;
  }
  s.stop(`${fitToWidth("Couldn't interpret that as a timezone.", suffix)}${k.dim(suffix)}`, 1);
  return null;
}

function buildPrompt(input: string): string {
  return [
    "Convert the user's description of where they are into a single IANA",
    'timezone identifier (e.g. "America/New_York", "Europe/London",',
    '"Asia/Jerusalem"). Respond with ONLY the IANA string on a single line,',
    'nothing else — no prose, no quotes, no punctuation. If you cannot',
    'determine a zone with reasonable confidence, reply with exactly:',
    'UNKNOWN',
    '',
    `User's description: ${input}`,
  ].join('\n');
}

function queryClaude(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('claude', ['-p', '--output-format', 'text'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let settled = false;
    const settle = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf-8');
    });
    child.on('close', (code) => {
      settle(code === 0 && stdout.trim() ? stdout : null);
    });
    child.on('error', () => settle(null));

    child.stdin.end(prompt);
  });
}

function extractTimezone(reply: string): string | null {
  // Claude occasionally prefixes with a backtick or wraps in quotes despite
  // instructions; take the first line that looks like a zone.
  const lines = reply
    .split('\n')
    .map((l) => l.trim().replace(/^["'`]+|["'`]+$/g, ''))
    .filter(Boolean);
  for (const line of lines) {
    if (line === 'UNKNOWN') return null;
    if (isValidTimezone(line)) return line;
  }
  return null;
}
