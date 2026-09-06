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
import { childEnvWithoutSetupSecrets } from './secret-file.js';
import { fitToWidth, fmtDuration } from './theme.js';
import type { SetupDriver } from './setup-driver.js';

const MAX_MACHINE_TIMEZONE_OUTPUT_BYTES = 64 * 1024;

export function claudeCliAvailable(driver?: SetupDriver): boolean {
  try {
    execSync('command -v claude', {
      stdio: 'ignore',
      ...(driver?.mode === 'ndjson' ? { env: childEnvWithoutSetupSecrets() } : {}),
    });
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
export async function resolveTimezoneViaClaude(input: string, driver?: SetupDriver): Promise<string | null> {
  if (!claudeCliAvailable(driver)) return null;

  const prompt = buildPrompt(input);

  if (driver?.mode === 'ndjson') {
    driver.progress('timezone-lookup', 'running', 'Looking up that timezone');
    const reply = await queryClaude(prompt, driver);
    driver.throwIfCancelled();
    const resolved = reply ? extractTimezone(reply) : null;
    driver.progress('timezone-lookup', resolved ? 'succeeded' : 'failed');
    return resolved;
  }

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
  s.error(`${fitToWidth("Couldn't interpret that as a timezone.", suffix)}${k.dim(suffix)}`);
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

function queryClaude(prompt: string, driver?: SetupDriver): Promise<string | null> {
  return new Promise((resolve) => {
    const machine = driver?.mode === 'ndjson';
    const child = spawn('claude', ['-p', '--output-format', 'text'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(machine ? { detached: true, env: childEnvWithoutSetupSecrets() } : {}),
    });
    let stdout = '';
    let outputBytes = 0;
    let settled = false;
    const settle = (value: string | null): void => {
      if (settled) return;
      settled = true;
      driver?.cancellationSignal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const stopGroup = (): void => {
      if (!machine || !child.pid) return;
      const processGroupId = child.pid;
      try {
        process.kill(-processGroupId, 'SIGTERM');
      } catch {
        /* already gone */
      }
      setTimeout(() => {
        try {
          process.kill(-processGroupId, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }, 250);
    };
    const onAbort = (): void => {
      stopGroup();
      settle(null);
    };
    driver?.cancellationSignal?.addEventListener('abort', onAbort, { once: true });
    if (driver?.cancellationSignal?.aborted) onAbort();

    const accepts = (chunk: Buffer): boolean => {
      if (settled) return false;
      if (machine) {
        outputBytes += chunk.byteLength;
        if (outputBytes > MAX_MACHINE_TIMEZONE_OUTPUT_BYTES) {
          stopGroup();
          settle(null);
          return false;
        }
      }
      return true;
    };
    child.stdout.on('data', (c: Buffer) => {
      if (!accepts(c)) return;
      stdout += c.toString('utf-8');
    });
    child.stderr.on('data', (c: Buffer) => {
      accepts(c);
    });
    child.on('close', (code) => {
      settle(code === 0 && stdout.trim() ? stdout : null);
    });
    child.on('error', () => settle(null));
    child.stdin.on('error', () => settle(null));

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
