import { spawnSync } from 'child_process';
import { mkdirSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

function log(message: string): void {
  console.error(`[opencode-memory] ${message}`);
}

export function openCodeInstructionsPath(): string {
  return path.resolve(process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share'), 'nanoclaw-instructions.md');
}

/** Refresh under the turn lock. Native steps and Task children reread this file. */
export function prepareOpenCodeMemory(
  hook: OpenCodeMemorySessionHook,
  instructions: string | undefined,
  reminder: string,
  file = openCodeInstructionsPath(),
): void {
  const content = [runMemorySessionHook(hook, 'startup'), instructions, reminder].filter(Boolean).join('\n\n');
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
}

export interface OpenCodeMemorySessionHook {
  readonly command: string;
  readonly legacyCommands: readonly string[];
  readonly sources: readonly string[];
}

/** Sources understood by the shared renderer; turn preparation uses startup. */
export type OpenCodeMemorySource = 'startup' | 'compact';

/** Matches the `timeout: 10` (seconds) the Claude provider registers for the same command. */
const MEMORY_HOOK_TIMEOUT_MS = 10_000;

/** Run the registered renderer without duplicating its memory caps. Failures
 * log and return undefined; successful empty output remains distinguishable.
 */
export function runMemorySessionHook(
  hook: OpenCodeMemorySessionHook | undefined,
  source: OpenCodeMemorySource,
): string | undefined {
  if (!hook) {
    log(`No memory session hook registered; skipping ${source} memory injection`);
    return undefined;
  }
  if (!hook.sources.includes(source)) {
    log(`Memory session hook does not declare source ${source}; skipping injection`);
    return undefined;
  }

  try {
    const res = spawnSync(hook.command, {
      shell: true,
      input: JSON.stringify({ hook_event_name: 'SessionStart', source }),
      encoding: 'utf-8',
      timeout: MEMORY_HOOK_TIMEOUT_MS,
    });
    if (res.error || res.status !== 0) {
      const why = res.error ? res.error.message : `exit ${String(res.status)}`;
      log(`Memory session hook (${source}) failed (${why}); continuing without memory`);
      return undefined;
    }
    const out = (res.stdout ?? '').trim();
    if (!out) {
      log(`Memory session hook (${source}) produced no output; continuing without memory`);
      return '';
    }
    return out;
  } catch (err) {
    log(`Memory session hook (${source}) failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}
