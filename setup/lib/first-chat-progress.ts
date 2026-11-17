/**
 * Live progress for setup's first chat: which stage the first reply is
 * waiting on, with the time each stage took.
 *
 * Stages come from signals every install has, whatever the agent provider or
 * gateway: the session row the host writes when it routes the message, the
 * sandbox status it records, and the heartbeat file the agent touches on
 * every runtime event. A finished stage stays on screen as its own line.
 */
import fs from 'node:fs';

import * as p from '@clack/prompts';
import k from 'kleur';

import { fitToWidth, fmtDuration, wrapForGutter } from './theme.js';

export type FirstChatStage = 'sending' | 'starting_sandbox' | 'starting_agent' | 'waiting_for_reply';

// The first-chat step's lines: intro, stages, the keep-waiting question and
// the skip note. Each is a whole sentence with named placeholders filled by
// fill(), so a translation can reorder it. Failure notes live with the ping
// in agent-ping.ts.
export const SLOW_MODEL = 'A local model can take several minutes to load and read its first prompt.';
export const CHAT_LATER = 'Chat with it later using `pnpm run chat hi`.';
const LOG_HINT = 'If it never answers, check `logs/nanoclaw.log`.';

interface StageCopy {
  running: string;
  done: string;
  stillWaiting: string;
  skipped: string;
}

export const FIRST_CHAT_COPY = {
  intro:
    "Your assistant runs in an isolated sandbox. I'm going to send it a quick test message (ping) and wait for a reply (pong) to confirm it's responding. The first reply can take a minute or more while the sandbox starts and the model loads.",
  skippedTitle: 'Skipping the first chat',
  waking: 'Waking your assistant…',
  ready: 'Your assistant is ready.',
  replied: 'Your assistant replied.',
  waitEnded: 'The wait ended.',
  stoppedWaiting: 'Stopped waiting for the first reply.',
  slowModelHint: SLOW_MODEL,
  keepWaiting: 'Keep waiting',
  keepWaitingHint: `{minutes} more minutes. ${SLOW_MODEL}`,
  skip: 'Skip the first chat and finish setup',
  skipHint: CHAT_LATER,
  stillWaitingUnseen: 'Still waiting for a reply after {time}. Keep waiting?',
  skippedUnseen: 'Your assistant had not replied when you stopped waiting.',
  skippedNext: `Setup carries on without the first chat. ${CHAT_LATER} ${LOG_HINT}`,
  stages: {
    sending: {
      running: 'Sending a test message…',
      done: 'Test message received',
      stillWaiting: 'Still sending the test message after {time}. Keep waiting?',
      skipped: 'Your assistant was still sending the test message when you stopped waiting.',
    },
    starting_sandbox: {
      running: 'Starting the sandbox…',
      done: 'Sandbox started',
      stillWaiting: 'Still starting the sandbox after {time}. Keep waiting?',
      skipped: 'Your assistant was still starting the sandbox when you stopped waiting.',
    },
    starting_agent: {
      running: 'Starting the agent runtime…',
      done: 'Agent runtime started',
      stillWaiting: 'Still starting the agent runtime after {time}. Keep waiting?',
      skipped: 'Your assistant was still starting the agent runtime when you stopped waiting.',
    },
    waiting_for_reply: {
      running: "Waiting for the model's first reply…",
      done: 'Reply received',
      stillWaiting: "Still waiting for the model's first reply after {time}. Keep waiting?",
      skipped: "Your assistant was still waiting for the model's first reply when you stopped waiting.",
    },
  } satisfies Record<FirstChatStage, StageCopy>,
};

/** Fill {name} placeholders; an unknown one stays visible rather than vanishing. */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : match,
  );
}

const STAGES: FirstChatStage[] = ['sending', 'starting_sandbox', 'starting_agent', 'waiting_for_reply'];

// How long setup waits for a probe read still in flight before moving on.
const IDLE_WAIT_MS = 3_000;
// Shown once the model has been quiet this long; a hosted model rarely is.
const SLOW_MODEL_HINT_MS = 20_000;
const COPY = FIRST_CHAT_COPY.stages;

/**
 * Wizard text when the user stops waiting. Nothing has failed, so no
 * troubleshooting guide; the stage is only the last one seen, never assumed.
 */
export function skippedWaitCopy(stage: FirstChatStage | undefined): { spinner: string; note: string } {
  const seen = stage ? COPY[stage].skipped : FIRST_CHAT_COPY.skippedUnseen;
  const note = `${seen} ${FIRST_CHAT_COPY.skippedNext}`;
  return { spinner: FIRST_CHAT_COPY.stoppedWaiting, note: wrapForGutter(note, 6) };
}

/** The question setup asks when a wait window ends; it names a stage only once one was seen. */
export function keepWaitingQuestion(stage: FirstChatStage | undefined, waitedMs: number): string {
  const template = stage ? COPY[stage].stillWaiting : FIRST_CHAT_COPY.stillWaitingUnseen;
  return fill(template, { time: fmtDuration(waitedMs) });
}

export interface StageSignals {
  /** The host routed the message into a session. */
  session: boolean;
  /** The host recorded the session's sandbox as running. */
  sandboxRunning: boolean;
  /** The agent touched its heartbeat since the ping started. */
  agentActive: boolean;
}

export function stageFor(s: StageSignals): FirstChatStage {
  if (s.agentActive) return 'waiting_for_reply';
  if (s.sandboxRunning) return 'starting_agent';
  if (s.session) return 'starting_sandbox';
  return 'sending';
}

export interface FinishedStage {
  stage: FirstChatStage;
  ms: number;
}

/** Moves forward through the stages only, timing each one. */
export class StageTracker {
  private index = 0;
  private since: number;

  constructor(start: number) {
    this.since = start;
  }

  get stage(): FirstChatStage {
    return STAGES[this.index];
  }

  get stageStart(): number {
    return this.since;
  }

  /** Returns the stages that just finished; stages skipped over took 0s. */
  advance(stage: FirstChatStage, now: number): FinishedStage[] {
    const target = STAGES.indexOf(stage);
    const finished: FinishedStage[] = [];
    while (this.index < target) {
      finished.push({ stage: this.stage, ms: now - this.since });
      this.index++;
      this.since = now;
    }
    return finished;
  }

  finish(now: number): FinishedStage {
    return { stage: this.stage, ms: now - this.since };
  }
}

export interface SessionState {
  agentGroupId: string;
  sessionId: string;
  containerStatus: string | null;
}

export interface StageProbe {
  read(): Promise<StageSignals>;
}

export function createStageProbe(opts: {
  since: number;
  readSession: () => Promise<SessionState | null>;
  heartbeatFile: (agentGroupId: string, sessionId: string) => string;
}): StageProbe {
  const baselines = new Map<string, number>();
  return {
    async read() {
      const session = await opts.readSession();
      if (!session) return { session: false, sandboxRunning: false, agentActive: false };
      const mtime = mtimeMs(opts.heartbeatFile(session.agentGroupId, session.sessionId));
      const key = `${session.agentGroupId}/${session.sessionId}`;
      if (!baselines.has(key)) baselines.set(key, mtime);
      // A touch after the ping started, or any change since first seen: the
      // second covers a sandbox clock that runs behind the host's.
      const agentActive = mtime >= opts.since || mtime > baselines.get(key)!;
      return { session: true, sandboxRunning: session.containerStatus === 'running', agentActive };
    },
  };
}

function mtimeMs(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export interface SpinnerLike {
  start(msg?: string): void;
  stop(msg?: string): void;
  message(msg?: string): void;
  clear(): void;
}

export interface DisplayDeps {
  spinner?: () => SpinnerLike;
  step?: (msg: string) => void;
  note?: (msg: string) => void;
  now?: () => number;
}

/**
 * One spinner for the current stage, one line per finished stage. Until a
 * probe read succeeds it shows the old single "Waking your assistant…" line,
 * so a broken probe never claims a stage.
 */
export class StageDisplay {
  private readonly tracker: StageTracker;
  private readonly spinnerFactory: () => SpinnerLike;
  private readonly step: (msg: string) => void;
  private readonly note: (msg: string) => void;
  private readonly now: () => number;
  private spinner: SpinnerLike | null = null;
  private pending: FinishedStage[] = [];
  private known = false;
  private hinted = false;
  private done = false;
  private reading: Promise<void> | null = null;

  constructor(
    private readonly probe: StageProbe,
    deps: DisplayDeps = {},
    private readonly startedAt = Date.now(),
  ) {
    this.tracker = new StageTracker(startedAt);
    this.spinnerFactory = deps.spinner ?? (() => p.spinner());
    this.step = deps.step ?? ((msg) => p.log.step(msg));
    this.note = deps.note ?? ((msg) => process.stdout.write(gutterLines(msg)));
    this.now = deps.now ?? Date.now;
  }

  get stage(): FirstChatStage {
    return this.tracker.stage;
  }

  /** The current stage, once a probe read has shown one. */
  get seenStage(): FirstChatStage | undefined {
    return this.known ? this.tracker.stage : undefined;
  }

  start(): void {
    this.openSpinner();
  }

  /** Refresh the timer and read the signals; a slow read never stalls the timer. */
  tick(): Promise<void> {
    if (this.done) return Promise.resolve();
    this.reading ??= this.read().finally(() => (this.reading = null));
    this.redraw();
    return this.reading.then(() => this.redraw());
  }

  /** Resolves once no probe read is in flight, or after a short cap. */
  async idle(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const cap = new Promise<void>((resolve) => (timer = setTimeout(resolve, IDLE_WAIT_MS)));
    await Promise.race([this.reading, cap]);
    clearTimeout(timer);
  }

  pause(): void {
    this.spinner?.clear();
    this.spinner = null;
  }

  resume(): void {
    if (this.done || this.spinner) return;
    this.flush();
    this.openSpinner();
  }

  succeed(text: string): void {
    this.done = true;
    if (this.known) {
      this.pending.push(...this.tracker.advance('waiting_for_reply', this.now()), this.tracker.finish(this.now()));
      this.flush();
    }
    this.end(text);
  }

  fail(text: string): void {
    this.done = true;
    if (this.known) this.flush();
    this.end(text);
  }

  private async read(): Promise<void> {
    let signals: StageSignals | null = null;
    try {
      signals = await this.probe.read();
    } catch {
      // Keep the last stage; the next tick reads again.
    }
    if (this.done || !signals) return;
    this.known = true;
    this.pending.push(...this.tracker.advance(stageFor(signals), this.now()));
  }

  private redraw(): void {
    if (this.done || !this.spinner) return;
    if (this.pending.length > 0) {
      this.flush();
      this.openSpinner();
    } else if (this.slowModel()) {
      this.hinted = true;
      this.spinner.clear();
      this.note(FIRST_CHAT_COPY.slowModelHint);
      this.openSpinner();
    } else {
      this.spinner.message(this.label());
    }
  }

  private slowModel(): boolean {
    return (
      !this.hinted &&
      this.tracker.stage === 'waiting_for_reply' &&
      this.now() - this.tracker.stageStart >= SLOW_MODEL_HINT_MS
    );
  }

  private flush(): void {
    for (const { stage, ms } of this.pending.splice(0)) {
      const line = `${COPY[stage].done}${k.dim(` (${fmtDuration(ms)})`)}`;
      if (this.spinner) {
        this.spinner.stop(line);
        this.spinner = null;
      } else {
        this.step(line);
      }
    }
  }

  private end(text: string): void {
    const line = `${k.bold(text)}${k.dim(` (${fmtDuration(this.now() - this.startedAt)})`)}`;
    if (this.spinner) this.spinner.stop(line);
    else this.step(line);
    this.spinner = null;
  }

  private openSpinner(): void {
    this.spinner = this.spinnerFactory();
    this.spinner.start(this.label());
  }

  private label(): string {
    const base = this.known ? COPY[this.tracker.stage].running : FIRST_CHAT_COPY.waking;
    const since = this.known ? this.tracker.stageStart : this.startedAt;
    const suffix = ` (${fmtDuration(this.now() - since)})`;
    return `${fitToWidth(base, suffix)}${k.dim(suffix)}`;
  }
}

function gutterLines(text: string): string {
  return wrapForGutter(text, 6)
    .split('\n')
    .map((line) => `${k.gray('│')}  ${k.dim(line)}\n`)
    .join('');
}
