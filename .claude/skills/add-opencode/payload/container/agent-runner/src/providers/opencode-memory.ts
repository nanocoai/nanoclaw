import { spawnSync } from 'child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

function log(message: string): void {
  console.error(`[opencode-memory] ${message}`);
}

export interface OpenCodeMemorySnapshot {
  hook: OpenCodeMemorySessionHook;
  memory: string;
  instructions: string;
  reminder: string;
}

export function openCodeMemoryDirectory(): string {
  return path.join(process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share'), 'nanoclaw-memory');
}

function snapshotPath(directory: string, sessionId: string): string {
  if (!/^ses_[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error('Invalid OpenCode memory session id');
  return path.join(directory, `${sessionId}.json`);
}

export function readOpenCodeMemory(
  sessionId: string,
  directory = openCodeMemoryDirectory(),
): OpenCodeMemorySnapshot | undefined {
  try {
    const parsed = JSON.parse(readFileSync(snapshotPath(directory, sessionId), 'utf8')) as OpenCodeMemorySnapshot;
    if (
      typeof parsed.memory !== 'string' ||
      typeof parsed.instructions !== 'string' ||
      typeof parsed.reminder !== 'string' ||
      typeof parsed.hook?.command !== 'string' ||
      !Array.isArray(parsed.hook.sources)
    ) {
      throw new Error('Invalid OpenCode memory snapshot');
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function writeOpenCodeMemory(
  sessionId: string,
  snapshot: OpenCodeMemorySnapshot,
  directory = openCodeMemoryDirectory(),
): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = snapshotPath(directory, sessionId);
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(snapshot), { mode: 0o600, flag: 'wx' });
  renameSync(temporary, target);
}

/** Seed once on startup, preserve the rendered snapshot on cold resume. */
export function prepareOpenCodeMemory(
  sessionId: string,
  hook: OpenCodeMemorySessionHook,
  instructions: string | undefined,
  reminder: string,
  startup: boolean,
  directory = openCodeMemoryDirectory(),
): void {
  const prior = startup ? undefined : readOpenCodeMemory(sessionId, directory);
  writeOpenCodeMemory(
    sessionId,
    {
      hook,
      instructions: instructions ?? '',
      reminder,
      memory: startup ? (runMemorySessionHook(hook, 'startup') ?? '') : (prior?.memory ?? ''),
    },
    directory,
  );
}

export interface OpenCodeMemorySessionHook {
  readonly command: string;
  readonly legacyCommands: readonly string[];
  readonly sources: readonly string[];
}

/**
 * The two lifecycle points at which this provider establishes a new context
 * window. `clear` never appears: OpenCode has no in-session clear — a cleared
 * conversation arrives as a fresh session, i.e. `startup`. `resume` never
 * appears either, by contract: memory is not re-injected when an existing
 * session continues.
 */
export type OpenCodeMemorySource = 'startup' | 'compact';

/** Matches the `timeout: 10` (seconds) the Claude provider registers for the same command. */
const MEMORY_HOOK_TIMEOUT_MS = 10_000;

/**
 * Run the registered memory session hook and return what it printed.
 *
 * The hook reads a Claude-style SessionStart payload on stdin and prints the
 * rendered memory section on stdout (`src/memory/hook.ts`), which is where the
 * per-file caps and the "resume gets nothing" rule live. Nothing is capped or
 * rewritten here — whatever the command prints is what gets injected.
 *
 * Fails closed on every failure mode (unregistered, source the registration
 * does not declare, missing command, non-zero exit, timeout, empty stdout):
 * one log line, no injection, never a thrown turn.
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
