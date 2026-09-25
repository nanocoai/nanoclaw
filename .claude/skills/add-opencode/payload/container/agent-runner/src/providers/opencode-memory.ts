import { spawn } from 'child_process';
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
export async function prepareOpenCodeMemory(
  hook: OpenCodeMemorySessionHook,
  instructions: string | undefined,
  reminder: string,
  file = openCodeInstructionsPath(),
): Promise<void> {
  const content = [await runMemorySessionHook(hook, 'startup'), instructions, reminder].filter(Boolean).join('\n\n');
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

/**
 * Run one hook command with the payload on stdin; resolve with its exit status
 * and stdout. This is an async `spawn`, not `spawnSync`, on purpose: Bun's
 * synchronous wait loop can lose the child's exit and spin forever
 * (oven-sh/bun#34069, reproduced on 1.4.0; nanoclaw#3839). Every turn runs this
 * command next to sqlite, SSE sockets and timers, exactly the churn that
 * triggers it, and a synchronous spin is immune to every timeout we own.
 * The event-loop path reaps normally and lets our own deadline fire.
 */
export function runHookCommand(
  command: string,
  input: string,
  timeoutMs = MEMORY_HOOK_TIMEOUT_MS,
): Promise<{ status: number | null; stdout: string; error?: Error }> {
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    let settled = false;
    const settle = (result: { status: number | null; error?: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve({ ...result, stdout: Buffer.concat(stdout).toString('utf-8') });
    };
    const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const deadline = setTimeout(() => {
      // Settle now rather than on `close`: a hook that ignores SIGTERM, or
      // leaves a background child holding stdout, must not hold the turn lock.
      // spawnSync's timeout closed the pipes the same way.
      child.kill('SIGTERM');
      child.stdin.destroy();
      child.stdout.destroy();
      child.unref();
      settle({ status: null, error: new Error(`timed out after ${timeoutMs}ms`) });
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.on('error', (error) => settle({ status: null, error }));
    child.on('close', (status, signal) =>
      settle(signal ? { status, error: new Error(`killed by ${signal}`) } : { status }),
    );
    // A hook that never reads stdin (or exits early) closes the pipe under us.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** Run the registered renderer without duplicating its memory caps. Failures
 * log and return undefined; successful empty output remains distinguishable.
 */
export async function runMemorySessionHook(
  hook: OpenCodeMemorySessionHook | undefined,
  source: OpenCodeMemorySource,
): Promise<string | undefined> {
  if (!hook) {
    log(`No memory session hook registered; skipping ${source} memory injection`);
    return undefined;
  }
  if (!hook.sources.includes(source)) {
    log(`Memory session hook does not declare source ${source}; skipping injection`);
    return undefined;
  }

  try {
    const res = await runHookCommand(hook.command, JSON.stringify({ hook_event_name: 'SessionStart', source }));
    if (res.error || res.status !== 0) {
      const why = res.error ? res.error.message : `exit ${String(res.status)}`;
      log(`Memory session hook (${source}) failed (${why}); continuing without memory`);
      return undefined;
    }
    const out = res.stdout.trim();
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
