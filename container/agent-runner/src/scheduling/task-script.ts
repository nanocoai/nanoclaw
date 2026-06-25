import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { MessageInRow } from '../db/messages-in.js';
import { touchHeartbeat } from '../db/connection.js';
import { applyPreTaskScriptGuards } from '../poll-loop-extensions.js';

const SCRIPT_TIMEOUT_MS = 30_000;
const SCRIPT_MAX_BUFFER = 1024 * 1024;

export interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

function log(msg: string): void {
  console.error(`[task-script] ${msg}`);
}

export async function runScript(script: string, taskId: string): Promise<ScriptResult | null> {
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

    // Extension seam (INERT with no registrant). A downstream overlay may veto running a pre-agent
    // script for this task: a pre-agent script is a shell-exec primitive (bash on /tmp) that on a
    // confined session may need to NEVER run (confined scheduled tasks may be prompt-only; a scripted
    // task is anomalous legacy/injection), so it is the authoritative EXECUTION gate that also
    // neutralises a pre-existing scripted task a confined agent re-times or resumes. No registrant ⇒
    // null ⇒ the script runs exactly as upstream.
    const scriptGuardReason = applyPreTaskScriptGuards(msg);
    if (scriptGuardReason) {
      log(`task ${msg.id} skipped: ${scriptGuardReason}`);
      skipped.push(msg.id);
      continue;
    }

    log(`running script for task ${msg.id}`);
    touchHeartbeat();
    const result = await runScript(script, msg.id);
    touchHeartbeat();

    if (!result || !result.wakeAgent) {
      const reason = result ? 'wakeAgent=false' : 'script error/no output';
      log(`task ${msg.id} skipped: ${reason}`);
      skipped.push(msg.id);
      continue;
    }

    log(`task ${msg.id} wakeAgent=true, enriching prompt`);
    content.scriptOutput = result.data ?? null;
    keep.push({ ...msg, content: JSON.stringify(content) });
  }

  return { keep, skipped };
}
