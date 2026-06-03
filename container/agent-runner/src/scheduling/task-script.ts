import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { MessageInRow } from '../db/messages-in.js';
import { touchHeartbeat } from '../db/connection.js';

const SCRIPT_TIMEOUT_MS = 30_000;
const SCRIPT_MAX_BUFFER = 1024 * 1024;
const SCRIPT_RETRY_DELAY_MS = 3_000;

export interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

export interface ScriptFailure {
  reason: string; // Human-readable: error.message, 'no output', etc.
  exitCode?: number; // Bash exit code (e.g. curl 6=DNS, 28=timeout)
  nodeError?: string; // Node error code ('ENOENT', 'ETIMEDOUT')
}

function log(msg: string): void {
  console.error(`[task-script] ${msg}`);
}

export async function runScript(script: string, taskId: string): Promise<ScriptResult | ScriptFailure> {
  const scriptPath = path.join('/tmp', `task-script-${taskId}.sh`);
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile(
      'bash',
      [scriptPath],
      { timeout: SCRIPT_TIMEOUT_MS, maxBuffer: SCRIPT_MAX_BUFFER, env: process.env },
      (error, stdout, stderr) => {
        try {
          fs.unlinkSync(scriptPath);
        } catch {
          /* best-effort cleanup */
        }

        if (stderr) {
          log(`[${taskId}] stderr: ${stderr.slice(0, 500)}`);
        }

        if (error) {
          log(`[${taskId}] error: ${error.message}`);
          return resolve({
            reason: error.message,
            exitCode: 'status' in error ? (error as { status?: number }).status : undefined,
            nodeError: 'code' in error ? (error as { code?: string }).code : undefined,
          });
        }

        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) {
          log(`[${taskId}] no output`);
          return resolve({ reason: 'no output' });
        }

        try {
          const result = JSON.parse(lastLine);
          if (typeof result.wakeAgent !== 'boolean') {
            log(`[${taskId}] output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`);
            return resolve({ reason: 'output missing wakeAgent boolean' });
          }
          resolve(result as ScriptResult);
        } catch {
          log(`[${taskId}] output is not valid JSON: ${lastLine.slice(0, 200)}`);
          resolve({ reason: 'invalid JSON' });
        }
      },
    );
  });
}

export interface TaskScriptOutcome {
  keep: MessageInRow[];
  skipped: string[];
}

/**
 * Run pre-task scripts for any task messages that carry one, serially.
 * - Errors / missing output / wakeAgent=false → task id added to `skipped`.
 * - wakeAgent=true → content JSON is mutated to carry `scriptOutput`, so the
 *   formatter renders it into the prompt.
 * Non-task messages and tasks without scripts pass through unchanged.
 */
export async function applyPreTaskScripts(messages: MessageInRow[]): Promise<TaskScriptOutcome> {
  const keep: MessageInRow[] = [];
  const skipped: string[] = [];

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
    let result = await runScript(script, msg.id);
    touchHeartbeat();

    // Retry once on failure. We retry all failures (not just "transient")
    // because perfect classification is impossible — network failures like
    // curl exit 6/7/28 look identical to bash syntax errors from execFile's
    // perspective — and the cost of a false retry is low (max 30s).
    if ('reason' in result) {
      log(`task ${msg.id} script failed (${result.reason}), retrying in ${SCRIPT_RETRY_DELAY_MS / 1000}s`);
      touchHeartbeat();
      await new Promise((r) => setTimeout(r, SCRIPT_RETRY_DELAY_MS));
      result = await runScript(script, msg.id);
      touchHeartbeat();
    }

    if ('reason' in result) {
      log(`task ${msg.id} skipped: script error (${result.reason})`);
      skipped.push(msg.id);
      continue;
    }

    if (!result.wakeAgent) {
      log(`task ${msg.id} skipped: wakeAgent=false`);
      skipped.push(msg.id);
      continue;
    }

    log(`task ${msg.id} wakeAgent=true, enriching prompt`);
    content.scriptOutput = result.data ?? null;
    keep.push({ ...msg, content: JSON.stringify(content) });
  }

  return { keep, skipped };
}
