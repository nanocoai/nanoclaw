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

const STAGES: FirstChatStage[] = ['sending', 'starting_sandbox', 'starting_agent', 'waiting_for_reply'];

const COPY: Record<FirstChatStage, { running: string; done: string; waitingOn: string }> = {
  sending: { running: 'Sending a test message…', done: 'Test message received', waitingOn: 'sending the test message' },
  starting_sandbox: { running: 'Starting the sandbox…', done: 'Sandbox started', waitingOn: 'starting the sandbox' },
  starting_agent: {
    running: 'Starting the agent runtime…',
    done: 'Agent runtime started',
    waitingOn: 'starting the agent runtime',
  },
  waiting_for_reply: {
    running: "Waiting for the model's first reply…",
    done: 'Reply received',
    waitingOn: "waiting for the model's first reply",
  },
};

// How long setup waits for a probe read still in flight before moving on.
const IDLE_WAIT_MS = 3_000;
// Shown once the model has been quiet this long; a hosted model rarely is.
const SLOW_MODEL_HINT_MS = 20_000;
const SLOW_MODEL_HINT = 'A local model can take a few minutes to load before its first reply.';

/** The question setup asks when a wait window ends. */
export function keepWaitingQuestion(stage: FirstChatStage, waitedMs: number): string {
  return `Still ${COPY[stage].waitingOn} after ${fmtDuration(waitedMs)}. Keep waiting?`;
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
      this.note(SLOW_MODEL_HINT);
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
    const base = this.known ? COPY[this.tracker.stage].running : 'Waking your assistant…';
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
