import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { MessageInRow } from '../db/messages-in.js';
import { touchHeartbeat } from '../heartbeat.js';

const SCRIPT_TIMEOUT_MS = 30_000;
const SCRIPT_MAX_BUFFER = 1024 * 1024;
// On timeout the group gets SIGTERM, so a script can trap it and clean up as it could
// under execFile, then SIGKILL after the grace. 2 s is enough to drop a lock or temp dir
// and adds little to the 30 s budget. Worst case a timed-out script holds the queue for
// timeout + grace + reap cap (33 s at the defaults).
const SCRIPT_KILL_GRACE_MS = 2_000;
// SIGKILL is not synchronous; wait this long for the group to vanish before moving on.
const SCRIPT_KILL_REAP_MS = 1_000;

export interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

function log(msg: string): void {
  console.error(`[task-script] ${msg}`);
}

export async function runScript(
  script: string,
  taskId: string,
  timeoutMs: number = SCRIPT_TIMEOUT_MS,
): Promise<ScriptResult | null> {
  const scriptPath = path.join('/tmp', `task-script-${taskId}.sh`);
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    // Bash forks the last command of a script file instead of exec'ing it, so
    // killing bash alone orphans that child and its side effects still land.
    // Run the script in its own process group and kill the whole group.
    const child = spawn('bash', [scriptPath], { detached: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });

    const out = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const bytes = { stdout: 0, stderr: 0 };
    let killed = false;
    let overflow: 'stdout' | 'stderr' | null = null;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;

    const signalGroup = (signal: NodeJS.Signals | 0): boolean => {
      try {
        process.kill(-child.pid!, signal);
        return true;
      } catch {
        return false; // group already gone
      }
    };

    // After a kill, resolve only once the group is gone, so the next task's script
    // never overlaps this one and no signal is sent after the PGID could be reused.
    let closed = false;
    let groupGone = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const tryFinish = (): void => {
      if (closed && (!killed || groupGone)) finish(null);
    };
    const endGroup = (): void => {
      clearInterval(poll);
      clearTimeout(graceTimer);
      groupGone = true;
      // A process that left the group can still hold the pipes open; drop them
      // so 'close' fires, as execFile does.
      child.stdout.destroy();
      child.stderr.destroy();
      tryFinish();
    };
    const killGroup = (): void => {
      if (killed) return;
      killed = true;
      if (!signalGroup('SIGTERM')) return endGroup();
      poll = setInterval(() => {
        if (!signalGroup(0)) endGroup();
      }, 100);
      graceTimer = setTimeout(() => {
        signalGroup('SIGKILL');
        graceTimer = setTimeout(() => {
          log(`[${taskId}] process group still alive ${SCRIPT_KILL_REAP_MS}ms after SIGKILL; moving on`);
          endGroup();
        }, SCRIPT_KILL_REAP_MS);
      }, SCRIPT_KILL_GRACE_MS);
    };

    const timer = setTimeout(killGroup, timeoutMs);

    const collect = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      if (killed) return; // output is discarded anyway; keep draining without buffering
      out[stream].push(chunk);
      bytes[stream] += chunk.length;
      if (!overflow && bytes[stream] > SCRIPT_MAX_BUFFER) {
        overflow = stream;
        killGroup();
      }
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));

    let settled = false;
    const finish = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      clearTimeout(graceTimer);
      try {
        fs.unlinkSync(scriptPath);
      } catch {
        /* best-effort cleanup */
      }

      const stdout = Buffer.concat(out.stdout).toString('utf8');
      const stderr = Buffer.concat(out.stderr).toString('utf8');
      if (stderr) {
        log(`[${taskId}] stderr: ${stderr.slice(0, 500)}`);
      }

      if (error) {
        log(`[${taskId}] error: ${error.message}`);
        return resolve(null);
      }
      if (overflow) {
        log(`[${taskId}] error: ${overflow} maxBuffer length exceeded`);
        return resolve(null);
      }
      if (killed) {
        // Distinguish a script that ran too long from one that exited non-zero.
        log(`[${taskId}] timed out after ${timeoutMs}ms and was killed; output discarded`);
        return resolve(null);
      }
      if (exitCode !== 0) {
        const cause = exitCode === null ? `signal ${exitSignal}` : `exit code ${exitCode}`;
        log(`[${taskId}] error: Command failed (${cause}): bash ${scriptPath}`);
        return resolve(null);
      }

      const lines = stdout.trim().split('\n');
      const lastLine = lines[lines.length - 1];
      if (!lastLine) {
        log(`[${taskId}] no output`);
        return resolve(null);
      }

      try {
        const result = JSON.parse(lastLine);
        if (typeof result.wakeAgent !== 'boolean') {
          log(`[${taskId}] output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`);
          return resolve(null);
        }
        resolve(result as ScriptResult);
      } catch {
        log(`[${taskId}] output is not valid JSON: ${lastLine.slice(0, 200)}`);
        resolve(null);
      }
    };

    child.on('error', finish);
    // 'close' waits for every holder of the stdio pipes, including background
    // children of the script, so the timeout still covers them.
    child.on('close', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      closed = true;
      tryFinish();
    });
  });
}

/** Why a script gated its task: deliberate wakeAgent=false vs a broken script. */
export type ScriptSkipReason = 'gated' | 'error';

export interface TaskScriptOutcome {
  keep: MessageInRow[];
  skipped: Array<{ id: string; reason: ScriptSkipReason }>;
}

/**
 * Run pre-task scripts for any task messages that carry one, serially.
 * - Errors / missing output / wakeAgent=false → task id added to `skipped`,
 *   with the reason. The caller acks these as script-skips (not plain
 *   completions) so the host can count consecutive failures and back off.
 * - wakeAgent=true → content JSON is mutated to carry `scriptOutput`, so the
 *   formatter renders it into the prompt.
 * Non-task messages and tasks without scripts pass through unchanged.
 */
export async function applyPreTaskScripts(messages: MessageInRow[]): Promise<TaskScriptOutcome> {
  const keep: MessageInRow[] = [];
  const skipped: Array<{ id: string; reason: ScriptSkipReason }> = [];

  for (const msg of messages) {
    if (msg.kind !== 'task') {
      keep.push(msg);
      continue;
    }

    let content: Record<string, unknown>;
    try {
      content = JSON.parse(msg.content);
    } catch {
      keep.push(msg);
      continue;
    }

    const script = typeof content.script === 'string' ? (content.script as string) : null;
    if (!script) {
      keep.push(msg);
      continue;
    }

    log(`running script for task ${msg.id}`);
    touchHeartbeat();
    const result = await runScript(script, msg.id);
    touchHeartbeat();

    if (!result || !result.wakeAgent) {
      const reason: ScriptSkipReason = result ? 'gated' : 'error';
      log(`task ${msg.id} skipped: ${reason === 'gated' ? 'wakeAgent=false' : 'script error, timeout, or no output'}`);
      skipped.push({ id: msg.id, reason });
      continue;
    }

    log(`task ${msg.id} wakeAgent=true, enriching prompt`);
    content.scriptOutput = result.data ?? null;
    keep.push({ ...msg, content: JSON.stringify(content) });
  }

  return { keep, skipped };
}
