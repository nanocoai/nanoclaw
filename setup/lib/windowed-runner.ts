/**
 * Windowed step runner: shows a fixed-height rolling tail of a long step's
 * output so the user can see it's making progress, plus a stall detector
 * that interrupts with a "keep waiting or ask for help?" prompt when the
 * output stream goes silent for too long.
 *
 * Used for the container build (3–10 minutes on a fresh machine, no user
 * feedback with a plain spinner). Models the UI on claude-assist.ts's
 * 3-line action window — a single-line spinner header sitting above three
 * gutter-prefixed lines of the most recent output, redrawn in place via
 * ANSI cursor controls.
 *
 * Stall detection: a silence timer resets on every new line. When it hits
 * STALL_THRESHOLD_MS we pause the render, show `offerClaudeAssist` with
 * the step's raw log, and either resume (user said "keep waiting") or
 * let the step run its course while giving them the exit path.
 */
import * as p from '@clack/prompts';
import k from 'kleur';

import { offerClaudeOnFailure } from './claude-handoff.js';
import { emit as phEmit } from './diagnostics.js';
import type { QuietChildResult, StepResult, SpinnerLabels } from './runner.js';
import { dumpTranscriptOnFailure, spawnQuiet, spawnStep, writeStepEntry } from './runner.js';
import * as setupLog from '../logs.js';
import { brandBody, fitToWidth, fmtDuration } from './theme.js';

const WINDOW_SIZE = 3;
const SPINNER_FRAMES = ['◒', '◐', '◓', '◑'];
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const STALL_THRESHOLD_MS = 60_000;
// SIGHUP too: a child in its own process group misses the terminal's hangup.
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/**
 * Run a step with a 3-line rolling tail + stall detector. Same signature
 * shape as `runQuietStep` (so auto.ts can swap them), but tails the
 * child's stdout/stderr into a fixed-height window.
 */
export async function runWindowedStep(
  stepName: string,
  labels: SpinnerLabels,
  extra: string[] = [],
): Promise<StepResult & { rawLog: string; durationMs: number }> {
  const rawLog = setupLog.stepRawLog(stepName);
  const start = Date.now();
  phEmit('step_started', { step: stepName });

  const result = await runUnderWindow(stepName, labels, rawLog, (onLine) =>
    spawnStep(stepName, extra, () => {}, rawLog, onLine),
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

/**
 * Run an arbitrary command in the same window: the windowed twin of
 * `runQuietChild`, for long commands that are not setup steps (e.g. the
 * provider rebuild's `container/build.sh`).
 */
export async function runWindowedChild(
  logName: string,
  cmd: string,
  args: string[],
  labels: SpinnerLabels,
  opts?: { cwd?: string },
): Promise<QuietChildResult & { rawLog: string; durationMs: number }> {
  const rawLog = setupLog.stepRawLog(logName);
  const start = Date.now();
  phEmit('step_started', { step: logName });

  const stop = new AbortController();
  const result = await runUnderWindow(
    logName,
    labels,
    rawLog,
    (onLine) => spawnQuiet(cmd, args, rawLog, undefined, { cwd: opts?.cwd, onLine, stop: stop.signal }),
    stop,
  );

  const durationMs = Date.now() - start;
  writeStepEntry(logName, result, durationMs, rawLog);
  phEmit('step_completed', {
    step: logName,
    status: outcomeStatus(result),
    duration_ms: durationMs,
  });
  return { ...result, rawLog, durationMs };
}

function outcomeStatus(result: { ok: boolean; terminal: StepResult['terminal'] }): 'success' | 'skipped' | 'failed' {
  const rawStatus = result.terminal?.fields.STATUS;
  if (!result.ok) return 'failed';
  return rawStatus === 'skipped' ? 'skipped' : 'success';
}

/**
 * The core render + spawn loop. Kept separate from `runWindowedStep` so
 * the logging bookkeeping (writeStepEntry, phEmit) lives with the
 * public-facing wrapper and this function stays focused on terminal IO.
 *
 * `stopChild` stops the child's process group (see spawnQuiet's `stop`).
 * With it, Ctrl-C, Esc or a signal stops the child and waits for it before
 * setup exits. Without it (the first build, whose step may need the
 * terminal for sudo), the child shares the terminal's Ctrl-C as before.
 */
async function runUnderWindow<T extends { ok: boolean; transcript: string; terminal: StepResult['terminal'] }>(
  stepName: string,
  labels: SpinnerLabels,
  rawLog: string,
  spawnChild: (onLine: (line: string) => void) => Promise<T>,
  stopChild?: AbortController,
): Promise<T> {
  const out = process.stdout;
  const start = Date.now();
  const actions: string[] = [];
  let frameIdx = 0;
  let lastLineAt = Date.now();
  let stallPromptActive = false;
  let handledStall = false;
  let windowShown = true;
  let finished = false;
  let stall: Promise<void> | undefined;
  const closeStallPrompt = new AbortController();

  const redraw = (): void => {
    if (stallPromptActive) return;
    out.write(`\x1b[${WINDOW_SIZE + 1}A`);
    const icon = SPINNER_FRAMES[frameIdx % SPINNER_FRAMES.length];
    const suffix = ` (${fmtDuration(Date.now() - start)})`;
    const header = fitToWidth(labels.running, suffix);
    out.write(`\x1b[2K${k.cyan(icon)}  ${header}${k.dim(suffix)}\n`);

    for (let i = 0; i < WINDOW_SIZE; i++) {
      const idx = actions.length - WINDOW_SIZE + i;
      const action = idx >= 0 ? actions[idx] : '';
      out.write('\x1b[2K');
      if (action) {
        out.write(`${k.gray('│')}  ${k.dim(fitToWidth(action, ''))}`);
      } else {
        out.write(k.gray('│'));
      }
      out.write('\n');
    }
  };

  const clearBlock = (): void => {
    // The cursor rests on the line under the window, where the tty echoes a Ctrl-C's ^C.
    out.write(`\r\x1b[2K\x1b[${WINDOW_SIZE + 1}A`);
    for (let i = 0; i < WINDOW_SIZE + 1; i++) {
      out.write('\x1b[2K\n');
    }
    out.write(`\x1b[${WINDOW_SIZE + 1}A`);
  };

  out.write(HIDE_CURSOR);
  for (let i = 0; i < WINDOW_SIZE + 1; i++) out.write('\n');
  redraw();

  const restoreCursorOnExit = (): void => {
    out.write(SHOW_CURSOR);
  };
  process.once('exit', restoreCursorOnExit);
  // A signal kills Node without an 'exit' event: show the cursor, then
  // re-raise so the process still dies the default way. Node's own handler
  // would also leave raw mode (the stall prompt's); the re-raise skips it.
  // A stoppable child gets the signal first and the re-raise waits for it.
  let reraise: NodeJS.Signals | undefined;
  const stopListening = (): void => {
    for (const signal of FORWARDED_SIGNALS) process.off(signal, restoreCursorOnSignal);
  };
  const restoreCursorOnSignal = (signal: NodeJS.Signals): void => {
    // Still listening: a second Ctrl-C must not kill setup before the child is gone.
    if (reraise) return;
    reraise = signal;
    stopChild?.abort(signal);
    out.write(SHOW_CURSOR);
    if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
    // The main flow re-raises once the child is gone; after that, do it here.
    if (stopChild && !finished) return;
    stopListening();
    process.kill(process.pid, signal);
  };
  for (const signal of FORWARDED_SIGNALS) process.on(signal, restoreCursorOnSignal);

  const frameTick = setInterval(() => {
    frameIdx++;
    redraw();
  }, 250);

  const stallCheck = setInterval(() => {
    if (handledStall || stallPromptActive || reraise) return;
    if (Date.now() - lastLineAt < STALL_THRESHOLD_MS) return;
    handledStall = true;
    stall = handleStall(stepName, rawLog, closeStallPrompt.signal, {
      pauseRender: () => {
        stallPromptActive = true;
        clearBlock();
        windowShown = false;
        out.write(SHOW_CURSOR);
      },
      resumeRender: () => {
        // The step ended while the prompt was open: its result line replaces the window.
        if (finished) return;
        windowShown = true;
        out.write(HIDE_CURSOR);
        for (let i = 0; i < WINDOW_SIZE + 1; i++) out.write('\n');
        stallPromptActive = false;
        lastLineAt = Date.now();
        redraw();
      },
      stopChild: async () => {
        if (!stopChild) return;
        stopChild.abort('SIGINT');
        await child;
      },
    });
  }, 5_000);

  const onLine = (line: string): void => {
    lastLineAt = Date.now();
    // Strip ANSI escape sequences — Docker Buildx writes color codes that
    // mangle the rolling window layout when replayed in a narrow cell.
    // eslint-disable-next-line no-control-regex
    const clean = line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim();
    if (clean) actions.push(clean);
    redraw();
  };

  const child = spawnChild(onLine);
  const result = await child;

  finished = true;
  clearInterval(frameTick);
  clearInterval(stallCheck);
  if (reraise) {
    // The child is gone: die the way the signal asked, without waiting on a
    // Claude look. No listener is left, so this is the default action.
    if (windowShown) clearBlock();
    windowShown = false;
    stopListening();
    process.kill(process.pid, reraise);
  }
  // An unanswered stall prompt would keep reading stdin into the next step's
  // prompt. Close it, and wait out a Claude look the user already asked for.
  closeStallPrompt.abort();
  await stall;
  if (windowShown) clearBlock();
  out.write(SHOW_CURSOR);
  process.off('exit', restoreCursorOnExit);
  stopListening();

  const suffix = ` (${fmtDuration(Date.now() - start)})`;
  if (result.ok) {
    const isSkipped = result.terminal?.fields.STATUS === 'skipped';
    const msg = isSkipped && labels.skipped ? labels.skipped : labels.done;
    p.log.success(`${brandBody(fitToWidth(msg, suffix))}${k.dim(suffix)}`);
  } else {
    const failMsg = labels.failed ?? labels.running.replace(/…$/, ' failed');
    p.log.error(`${fitToWidth(failMsg, suffix)}${k.dim(suffix)}`);
    dumpTranscriptOnFailure(result.transcript);
  }
  return result;
}

async function handleStall(
  stepName: string,
  rawLog: string,
  stepEnded: AbortSignal,
  render: { pauseRender: () => void; resumeRender: () => void; stopChild: () => Promise<void> },
): Promise<void> {
  render.pauseRender();
  p.log.warn(brandBody(`This looks stuck — no output from the ${stepName} step for the last 60 seconds.`));
  phEmit('step_stalled', { step: stepName });

  const { ensureAnswer } = await import('./runner.js');
  const { brightSelect } = await import('./bright-select.js');

  const answer = await brightSelect<'wait' | 'help'>({
    message: 'What now?',
    options: [
      {
        value: 'wait',
        label: 'Keep waiting',
        hint: 'large images can take 5–10 minutes',
      },
      {
        value: 'help',
        label: 'Ask Claude to take a look',
        hint: 'reads the raw build log and suggests a fix',
      },
    ],
    signal: stepEnded,
    abortedLabel: () => 'It finished on its own.',
  });
  // Closed because the step ended, not by the user: nothing left to decide.
  if (stepEnded.aborted) return;
  // Ctrl-C or Esc here is a prompt cancel, not a signal: stop the child
  // and wait for it before ensureAnswer exits setup.
  if (p.isCancel(answer)) await render.stopChild();
  const choice = ensureAnswer(answer);

  if (choice === 'help') {
    // offerClaudeAssist runs its own spinner and may propose a fix command.
    // We don't attempt to restart the stalled build from here — if Claude
    // proposes a command the user accepts, they can retry setup afterwards.
    await offerClaudeOnFailure({
      stepName,
      msg: `The ${stepName} step has produced no output for 60 seconds.`,
      hint: 'It may be hung on a slow network pull or a failing Dockerfile step.',
      rawLogPath: rawLog,
    });
    // Keep the spinner going — the underlying process is still running,
    // and cancelling it here would race with Claude's investigation. The
    // user can Ctrl-C if they want to bail.
  }

  render.resumeRender();
}
