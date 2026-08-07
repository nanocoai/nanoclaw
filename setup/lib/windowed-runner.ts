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
import type { StepResult, SpinnerLabels } from './runner.js';
import { dumpTranscriptOnFailure, spawnStep, writeStepEntry } from './runner.js';
import * as setupLog from '../logs.js';
import { brandBody, fitToWidth, fmtDuration } from './theme.js';

const WINDOW_SIZE = 3;
const SPINNER_FRAMES = ['◒', '◐', '◓', '◑'];
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const STALL_THRESHOLD_MS = 60_000;

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

  const result = await runUnderWindow(stepName, labels, extra, rawLog);

  const durationMs = Date.now() - start;
  writeStepEntry(stepName, result, durationMs, rawLog);
  phEmit('step_completed', {
    step: stepName,
    status: outcomeStatus(result),
    duration_ms: durationMs,
  });
  return { ...result, rawLog, durationMs };
}

function outcomeStatus(result: StepResult): 'success' | 'skipped' | 'failed' {
  const rawStatus = result.terminal?.fields.STATUS;
  if (!result.ok) return 'failed';
  return rawStatus === 'skipped' ? 'skipped' : 'success';
}

/**
 * The core render + spawn loop. Kept separate from `runWindowedStep` so
 * the logging bookkeeping (writeStepEntry, phEmit) lives with the
 * public-facing wrapper and this function stays focused on terminal IO.
 */
async function runUnderWindow(
  stepName: string,
  labels: SpinnerLabels,
  extra: string[],
  rawLog: string,
): Promise<StepResult> {
  const out = process.stdout;
  const start = Date.now();
  const actions: string[] = [];
  let frameIdx = 0;
  let lastLineAt = Date.now();
  let stallPromptActive = false;
  let handledStall = false;

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
    out.write(`\x1b[${WINDOW_SIZE + 1}A`);
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

  const frameTick = setInterval(() => {
    frameIdx++;
    redraw();
  }, 250);

  const stallCheck = setInterval(() => {
    if (handledStall || stallPromptActive) return;
    if (Date.now() - lastLineAt < STALL_THRESHOLD_MS) return;
    handledStall = true;
    void handleStall(stepName, rawLog, {
      pauseRender: () => {
        stallPromptActive = true;
        clearBlock();
        out.write(SHOW_CURSOR);
      },
      resumeRender: () => {
        out.write(HIDE_CURSOR);
        for (let i = 0; i < WINDOW_SIZE + 1; i++) out.write('\n');
        stallPromptActive = false;
        lastLineAt = Date.now();
        redraw();
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

  const result = await spawnStep(stepName, extra, () => {}, rawLog, onLine);

  clearInterval(frameTick);
  clearInterval(stallCheck);
  clearBlock();
  out.write(SHOW_CURSOR);
  process.off('exit', restoreCursorOnExit);

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
  render: { pauseRender: () => void; resumeRender: () => void },
): Promise<void> {
  render.pauseRender();
  p.log.warn(
    brandBody(`This looks stuck — no output from the ${stepName} step for the last 60 seconds.`),
  );
  phEmit('step_stalled', { step: stepName });

  const { ensureAnswer } = await import('./runner.js');
  const { brightSelect } = await import('./bright-select.js');

  const choice = ensureAnswer(
    await brightSelect<'wait' | 'help'>({
      message: "What now?",
      options: [
        {
          value: 'wait',
          label: "Keep waiting",
          hint: "large images can take 5–10 minutes",
        },
        {
          value: 'help',
          label: 'Ask Claude to take a look',
          hint: 'reads the raw build log and suggests a fix',
        },
      ],
    }),
  );

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
