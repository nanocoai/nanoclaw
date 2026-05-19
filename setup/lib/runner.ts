/**
 * Step runner + abort helpers for setup:auto.
 *
 * Responsibilities:
 *   - Stream-parse setup-step status blocks (`=== NANOCLAW SETUP: … ===`)
 *   - Spawn children with output tee'd to a per-step raw log (level 3)
 *   - Wrap each run in a clack spinner with live elapsed time (level 1)
 *   - Append a structured entry to the progression log (level 2) via
 *     `setup/logs.ts` when the run ends
 *   - Abort helpers (`fail`, `ensureAnswer`) used by step orchestrators
 *
 * See docs/setup-flow.md for the three-level output contract.
 */
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';

import * as p from '@clack/prompts';
import k from 'kleur';

import * as setupLog from '../logs.js';
import { offerAiCodingCliOnFailure } from './cli-handoff.js';
import { emit as phEmit } from './diagnostics.js';
import { brandBody, fitToWidth, fmtDuration } from './theme.js';

export type Fields = Record<string, string>;
export type Block = { type: string; fields: Fields };

export type StepResult = {
  ok: boolean;
  exitCode: number;
  blocks: Block[];
  transcript: string;
  /** The last block with a STATUS field (the terminal/result block). */
  terminal: Block | null;
};

export type QuietChildResult = {
  ok: boolean;
  exitCode: number;
  transcript: string;
  terminal: Block | null;
  blocks: Block[];
};

export type SpinnerLabels = {
  running: string;
  done: string;
  skipped?: string;
  failed?: string;
};

/**
 * Streaming parser for `=== NANOCLAW SETUP: TYPE ===` blocks. Emits each
 * block as it closes so the UI can react mid-stream (e.g. render a pairing
 * code card as soon as pair-telegram emits it, rather than after the step
 * has finished).
 */
export class StatusStream {
  private lineBuf = '';
  private current: Block | null = null;
  readonly blocks: Block[] = [];
  transcript = '';

  constructor(private readonly onBlock: (block: Block) => void) {}

  write(chunk: string): void {
    this.transcript += chunk;
    this.lineBuf += chunk;
    let idx: number;
    while ((idx = this.lineBuf.indexOf('\n')) !== -1) {
      const line = this.lineBuf.slice(0, idx);
      this.lineBuf = this.lineBuf.slice(idx + 1);
      this.processLine(line);
    }
  }

  private processLine(line: string): void {
    const start = line.match(/^=== NANOCLAW SETUP: (\S+) ===/);
    if (start) {
      this.current = { type: start[1], fields: {} };
      return;
    }
    if (line.startsWith('=== END ===')) {
      if (this.current) {
        this.blocks.push(this.current);
        this.onBlock(this.current);
        this.current = null;
      }
      return;
    }
    if (!this.current) return;
    const colon = line.indexOf(':');
    if (colon === -1) return;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key) this.current.fields[key] = value;
  }
}

/**
 * Spawn a setup step as a child process. Output is tee'd to the provided
 * raw log file (level 3) and parsed for status blocks (level 2 summary).
 * The onBlock callback fires per status block as they close so the UI can
 * react mid-stream.
 *
 * `onLine`, if provided, fires for every line from stdout + stderr (minus
 * status-block control lines) so callers can render a rolling tail. Status
 * block lines are still parsed by the `StatusStream` — they're just
 * excluded from the line feed so they don't fill the user-facing window
 * with `=== NANOCLAW SETUP: …` noise.
 */
export function spawnStep(
  stepName: string,
  extra: string[],
  onBlock: (block: Block) => void,
  rawLogPath: string,
  onLine?: (line: string) => void,
): Promise<StepResult> {
  return new Promise((resolve) => {
    const args = ['exec', 'tsx', 'setup/index.ts', '--step', stepName];
    if (extra.length > 0) args.push('--', ...extra);

    const child = spawn('pnpm', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stream = new StatusStream(onBlock);
    const raw = fs.createWriteStream(rawLogPath, { flags: 'w' });
    raw.write(`# ${stepName} — ${new Date().toISOString()}\n\n`);

    // Per-line forwarder for the optional onLine callback. We keep our own
    // buffer (separate from StatusStream's) so the parser still gets raw
    // chunks and isn't forced through a line-by-line path it doesn't need.
    let lineBuf = '';
    const pushLines = (chunk: string): void => {
      if (!onLine) return;
      lineBuf += chunk;
      let idx: number;
      while ((idx = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, idx).replace(/\r/g, '');
        lineBuf = lineBuf.slice(idx + 1);
        if (line.startsWith('=== NANOCLAW SETUP:')) continue;
        if (line.startsWith('=== END ===')) continue;
        if (line.trim()) onLine(line);
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      const s = chunk.toString('utf-8');
      stream.write(s);
      raw.write(chunk);
      pushLines(s);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const s = chunk.toString('utf-8');
      stream.transcript += s;
      raw.write(chunk);
      pushLines(s);
    });

    child.on('close', (code) => {
      raw.end();
      const terminal =
        [...stream.blocks].reverse().find((b) => b.fields.STATUS) ?? null;
      const status = terminal?.fields.STATUS;
      const ok = code === 0 && (status === 'success' || status === 'skipped');
      resolve({
        ok,
        exitCode: code ?? 1,
        blocks: stream.blocks,
        transcript: stream.transcript,
        terminal,
      });
    });
  });
}

export function spawnQuiet(
  cmd: string,
  args: string[],
  rawLogPath: string,
  envOverride?: NodeJS.ProcessEnv,
): Promise<QuietChildResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: envOverride ? { ...process.env, ...envOverride } : process.env,
    });
    let transcript = '';
    const raw = fs.createWriteStream(rawLogPath, { flags: 'w' });
    raw.write(`# ${[cmd, ...args].join(' ')} — ${new Date().toISOString()}\n\n`);
    const blocks: Block[] = [];
    const stream = new StatusStream((b) => blocks.push(b));
    child.stdout.on('data', (c: Buffer) => {
      const s = c.toString('utf-8');
      transcript += s;
      stream.write(s);
      raw.write(c);
    });
    child.stderr.on('data', (c: Buffer) => {
      transcript += c.toString('utf-8');
      raw.write(c);
    });
    child.on('close', (code) => {
      raw.end();
      const terminal =
        [...blocks].reverse().find((b) => b.fields.STATUS) ?? null;
      resolve({ ok: code === 0, exitCode: code ?? 1, transcript, terminal, blocks });
    });
  });
}

/** Run a step under a clack spinner. Teed to a per-step raw log + progression entry at the end. */
export async function runQuietStep(
  stepName: string,
  labels: SpinnerLabels,
  extra: string[] = [],
): Promise<StepResult & { rawLog: string; durationMs: number }> {
  const rawLog = setupLog.stepRawLog(stepName);
  const start = Date.now();
  phEmit('step_started', { step: stepName });
  const result = await runUnderSpinner(labels, () =>
    spawnStep(stepName, extra, () => {}, rawLog),
  );
  const durationMs = Date.now() - start;
  writeStepEntry(stepName, result, durationMs, rawLog);
  phEmit('step_completed', {
    step: stepName,
    status: outcomeStatus(result),
    duration_ms: durationMs,
  });
  return { ...result, rawLog, durationMs };
}

/** Run an arbitrary child under a spinner. Same raw-log + progression treatment as runQuietStep. */
export async function runQuietChild(
  logName: string,
  cmd: string,
  args: string[],
  labels: SpinnerLabels,
  opts?: {
    /** Extra fields to merge into the progression entry (on top of any status-block fields). */
    extraFields?: Record<string, string | number | boolean>;
    /** Environment overrides to pass to the child process. */
    env?: NodeJS.ProcessEnv;
  },
): Promise<QuietChildResult & { rawLog: string; durationMs: number }> {
  const rawLog = setupLog.stepRawLog(logName);
  const start = Date.now();
  phEmit('step_started', { step: logName });
  const result = await runUnderSpinner(labels, () =>
    spawnQuiet(cmd, args, rawLog, opts?.env),
  );
  const durationMs = Date.now() - start;

  const blockFields = summariseTerminalFields(result.terminal);
  const fields = { ...blockFields, ...(opts?.extraFields ?? {}) };
  const rawStatus = result.terminal?.fields.STATUS;
  const status: 'success' | 'skipped' | 'failed' = !result.ok
    ? 'failed'
    : rawStatus === 'skipped'
      ? 'skipped'
      : 'success';
  setupLog.step(logName, status, durationMs, fields, rawLog);
  phEmit('step_completed', { step: logName, status, duration_ms: durationMs });
  return { ...result, rawLog, durationMs };
}

/** Collapse a step run into the three-way status used by diagnostics + progression log. */
function outcomeStatus(result: StepResult): 'success' | 'skipped' | 'failed' {
  const rawStatus = result.terminal?.fields.STATUS;
  if (!result.ok) return 'failed';
  return rawStatus === 'skipped' ? 'skipped' : 'success';
}

/** Turn a step's terminal-block fields into a concise progression-log entry. */
export function writeStepEntry(
  stepName: string,
  result: StepResult,
  durationMs: number,
  rawLog: string,
): void {
  const rawStatus = result.terminal?.fields.STATUS;
  const logStatus: 'success' | 'skipped' | 'failed' = !result.ok
    ? 'failed'
    : rawStatus === 'skipped'
      ? 'skipped'
      : 'success';
  const fields = summariseTerminalFields(result.terminal);
  setupLog.step(stepName, logStatus, durationMs, fields, rawLog);
}

/** Strip STATUS + LOG (redundant) and any oversize values from the terminal block's fields. */
export function summariseTerminalFields(block: Block | null): Record<string, string> {
  if (!block) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(block.fields)) {
    if (k === 'STATUS' || k === 'LOG') continue;
    if (v.length > 120) continue; // keep it skimmable; full value lives in the raw log
    out[k] = v;
  }
  return out;
}

async function runUnderSpinner<
  T extends { ok: boolean; transcript: string; terminal?: Block | null },
>(
  labels: SpinnerLabels,
  work: () => Promise<T>,
): Promise<T> {
  const s = p.spinner();
  const start = Date.now();
  s.start(fitToWidth(labels.running, ' (99m 59s)'));
  const tick = setInterval(() => {
    const suffix = ` (${fmtDuration(Date.now() - start)})`;
    s.message(`${fitToWidth(labels.running, suffix)}${k.dim(suffix)}`);
  }, 1000);

  const result = await work();

  clearInterval(tick);
  const suffix = ` (${fmtDuration(Date.now() - start)})`;
  if (result.ok) {
    const isSkipped = result.terminal?.fields.STATUS === 'skipped';
    const msg = isSkipped && labels.skipped ? labels.skipped : labels.done;
    // Bold the outcome so the step's headline reads stronger than the prose
    // body copy around it. The trailing `(Ns)` timing stays dim.
    s.stop(`${k.bold(fitToWidth(msg, suffix))}${k.dim(suffix)}`);
  } else {
    const failMsg = labels.failed ?? labels.running.replace(/…$/, ' failed');
    s.stop(`${k.bold(fitToWidth(failMsg, suffix))}${k.dim(suffix)}`, 1);
    dumpTranscriptOnFailure(result.transcript);
  }
  return result;
}

export function dumpTranscriptOnFailure(transcript: string): void {
  const lines = transcript.split('\n').filter((l) => {
    if (l.startsWith('=== NANOCLAW SETUP:')) return false;
    if (l.startsWith('=== END ===')) return false;
    return true;
  });
  const tail = lines.slice(-40).join('\n').trimEnd();
  if (tail) {
    console.log();
    console.log(k.dim(tail));
    console.log();
  }
}

/**
 * Abort the setup run with a user-facing error, logging the abort to the
 * progression log. Takes the step name explicitly so callers are clear
 * about which step they're failing from — no hidden module state.
 *
 * Before aborting we offer AI-coding CLI-assisted debugging. Callers must
 * `await fail(...)` so the offer can actually run before we call
 * process.exit. The return type is `Promise<never>`; control-flow
 * narrowing still works after `await`.
 */
export async function fail(
  stepName: string,
  msg: string,
  hint?: string,
  rawLogPath?: string,
): Promise<never> {
  setupLog.abort(stepName, msg);
  phEmit('setup_aborted', { step: stepName, reason: msg });
  p.log.error(msg);
  if (hint) p.log.message(k.dim(hint));
  p.log.message(k.dim('Logs: logs/setup.log · Raw: logs/setup-steps/'));

  const ranFix = await offerAiCodingCliOnFailure({ stepName, msg, hint, rawLogPath });

  // If the user just ran a CLI-suggested fix, offer to resume the flow
  // at the step that failed instead of aborting. We re-exec via spawnSync
  // and pass NANOCLAW_SKIP with every step that already completed so the
  // child skips them and picks up where we left off.
  if (ranFix) {
    const retry = ensureAnswer(
      await p.confirm({
        message: `Fix applied. Retry the ${stepName} step?`,
        initialValue: true,
      }),
    );
    if (retry) {
      const existingSkip = (process.env.NANOCLAW_SKIP ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const skipList = [
        ...new Set([...existingSkip, ...setupLog.completedStepNames()]),
      ].join(',');
      p.log.step(brandBody(`Retrying from ${stepName}…`));
      const result = spawnSync('pnpm', ['--silent', 'run', 'setup:auto'], {
        stdio: 'inherit',
        env: { ...process.env, NANOCLAW_SKIP: skipList },
      });
      process.exit(result.status ?? 0);
    }
  }

  p.cancel('Setup aborted.');
  process.exit(1);
}

/**
 * Unwrap a clack prompt result. If the user cancelled (Ctrl-C / Esc), exit
 * gracefully. Cancel is exit 0 — it's not an abort worth logging to the
 * progression log, since the operator initiated it deliberately.
 */
export function ensureAnswer<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }
  return value as T;
}
