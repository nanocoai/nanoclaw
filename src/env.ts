import fs from 'fs';
import path from 'path';
import { log } from './log.js';

export interface EnvFileReadResult {
  values: Record<string, string>;
  /** Set only when `.env` exists but could not be read; ENOENT is not an error. */
  error?: NodeJS.ErrnoException;
}

/**
 * Parse the .env file and return values for the requested keys, plus whether
 * an existing file was unreadable.
 *
 * A missing `.env` is the documented first-run default and is not an error.
 * A file that exists but cannot be read is different: callers that derive a
 * security boundary from it must treat the value as unknown, not as unset.
 *
 * `projectRoot` defaults to the current working directory; pass it when
 * reading a .env that is not the running process's own.
 */
export function readEnvFileResult(keys: string[], projectRoot?: string): EnvFileReadResult {
  const envFile = path.join(projectRoot ?? process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') {
      log.debug('.env file not found, using defaults', { err });
      return { values: {} };
    }
    log.warn('.env file exists but could not be read', { err });
    return { values: {}, error };
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

  return { values: result };
}

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 *
 * Callers that need to distinguish "missing" from "exists but unreadable"
 * should use `readEnvFileResult` instead; this wrapper keeps the existing
 * call sites' return type.
 */
export function readEnvFile(keys: string[], projectRoot?: string): Record<string, string> {
  return readEnvFileResult(keys, projectRoot).values;
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
