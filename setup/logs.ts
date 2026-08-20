/**
 * Three-level setup logging primitives. See docs/setup-flow.md for the
 * contract and design rationale.
 *
 *   Level 1: clack UI in setup/auto.ts (not here)
 *   Level 2: logs/setup.log — structured, append-only progression log
 *   Level 3: logs/setup-steps/NN-name.log — raw stdout+stderr per step
 *
 * Usage from auto.ts:
 *
 *   import * as setupLog from './logs.js';
 *
 *   const rawLog = setupLog.stepRawLog('container');
 *   const { ok, durationMs, terminal } =
 *     await spawnIntoRawLog('...', rawLog);
 *   setupLog.step('container', ok ? 'success' : 'failed', durationMs,
 *     { RUNTIME: 'docker', BUILD_OK: terminal.fields.BUILD_OK },
 *     rawLog);
 *
 * nanoclaw.sh emits the bootstrap entry directly via a bash helper so
 * the format stays consistent without needing IPC between bash and tsx.
 */
import fs from 'fs';
import path from 'path';

const LOGS_DIR = 'logs';
const STEPS_DIR = path.join(LOGS_DIR, 'setup-steps');
const PROGRESS_LOG = path.join(LOGS_DIR, 'setup.log');

export const progressLogPath = PROGRESS_LOG;
export const stepsDir = STEPS_DIR;

// Track steps that finished cleanly in this run. Used by fail() to build
// a NANOCLAW_SKIP list when re-executing after a Claude-assisted fix, so
// the retry picks up at the failing step instead of redoing every step
// before it.
const completedInRun = new Set<string>();

export function completedStepNames(): string[] {
  return [...completedInRun];
}

/** Wipe prior logs and write a header. Called once per fresh run (by nanoclaw.sh or as a fallback by auto.ts if invoked standalone). */
export function reset(meta: Record<string, string>): void {
  if (fs.existsSync(STEPS_DIR)) {
    fs.rmSync(STEPS_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(STEPS_DIR, { recursive: true });
  if (fs.existsSync(PROGRESS_LOG)) fs.unlinkSync(PROGRESS_LOG);
  header(meta);
}

/** Append a run-start header to the progression log. Idempotent: creates the file if missing. */
export function header(meta: Record<string, string>): void {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const ts = new Date().toISOString();
  const lines = [`## ${ts} · setup:auto started`];
  for (const [k, v] of Object.entries(meta)) {
    lines.push(`  ${k}: ${v}`);
  }
  lines.push('');
  fs.appendFileSync(PROGRESS_LOG, lines.join('\n') + '\n');
}

/** Append one step entry to the progression log. */
export function step(
  name: string,
  status: 'success' | 'skipped' | 'failed' | 'aborted' | 'interactive',
  durationMs: number,
  fields: Record<string, string | number | boolean | undefined>,
  rawRel?: string,
): void {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const ts = new Date().toISOString();
  const dur = formatDuration(durationMs);
  const lines = [`=== [${ts}] ${name} [${dur}] → ${status} ===`];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue;
    lines.push(`  ${k.toLowerCase()}: ${String(v)}`);
  }
  if (rawRel) lines.push(`  raw: ${rawRel}`);
  lines.push('');
  fs.appendFileSync(PROGRESS_LOG, lines.join('\n') + '\n');

  if (status === 'success' || status === 'skipped') {
    completedInRun.add(name);
  }
}

/** A user answered a prompt. Logs as its own entry because the setup path depends on it. */
export function userInput(key: string, value: string): void {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const ts = new Date().toISOString();
  fs.appendFileSync(PROGRESS_LOG, `=== [${ts}] user-input → ${key} ===\n  value: ${value}\n\n`);
}

/** Append the success footer. */
export function complete(totalMs: number): void {
  const ts = new Date().toISOString();
  fs.appendFileSync(PROGRESS_LOG, `## ${ts} · completed (total ${formatDurationTotal(totalMs)})\n`);
}

/** Append the failure footer. Keep error short — full context lives in the failing step's raw log. */
export function abort(stepName: string, error: string): void {
  const ts = new Date().toISOString();
  fs.appendFileSync(PROGRESS_LOG, `## ${ts} · aborted at ${stepName} (${error})\n`);
}

/**
 * Return the next raw-log path for a given step name. Numbering is derived
 * from the count of existing NN-*.log files in STEPS_DIR, so bootstrap's
 * pre-existing 01-bootstrap.log (written by nanoclaw.sh before this module
 * is loaded) counts toward the sequence.
 */
export function stepRawLog(name: string): string {
  fs.mkdirSync(STEPS_DIR, { recursive: true });
  const existing = fs.readdirSync(STEPS_DIR).filter((n) => /^\d+-.+\.log$/.test(n));
  const nextIdx = existing.length + 1;
  const num = String(nextIdx).padStart(2, '0');
  const safeName = name.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  return path.join(STEPS_DIR, `${num}-${safeName}.log`);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatDurationTotal(ms: number): string {
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return mins > 0 ? `${mins}m${secs}s` : `${secs}s`;
}
