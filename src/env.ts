import fs from 'fs';
import path from 'path';
import { log } from './log.js';

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 *
 * `projectRoot` defaults to the current working directory; pass it when
 * reading a .env that is not the running process's own.
 */
export function readEnvFile(keys: string[], projectRoot?: string): Record<string, string> {
  const envFile = path.join(projectRoot ?? process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    log.debug('.env file not found, using defaults', { err });
    return {};
  }

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}

/**
 * Read one key from the .env file. Same parser, same rules as `readEnvFile` —
 * this is the single-key form of it, so a caller wanting one value does not
 * hand-roll `readEnvFile([KEY])[KEY]` and does not grow a second parser.
 *
 * Returns undefined when the file, the key, or the value is absent.
 */
export function envValue(key: string, projectRoot?: string): string | undefined {
  return readEnvFile([key], projectRoot)[key];
}
