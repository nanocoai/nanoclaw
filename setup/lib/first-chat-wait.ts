/**
 * How long setup waits for the assistant's first reply.
 *
 * A first reply waits on the sandbox, the agent runtime and the model. A
 * hosted model usually answers within a minute; a local model loading for the
 * first time can take several. So setup waits one window, then asks whether
 * to keep waiting, one more window per yes. With nobody to ask (no TTY) it
 * gives up after the first window, as before.
 */
import type { CliPing, PingOutcome } from './agent-ping.js';

// Twice the 30-60s cold start most installs see, and the same 2 minutes
// `pnpm run chat` already allows a person at the terminal.
export const FIRST_WAIT_MS = 120_000;
// A model still loading after 2 minutes rarely needs only seconds more.
export const EXTRA_WAIT_MS = 120_000;
// Upper bound handed to the chat client, so a forgotten wait still ends.
export const MAX_WAIT_MS = 60 * 60_000;

export type WaitChoice = 'wait' | 'skip';

export interface FirstReplyWait {
  outcome: PingOutcome;
  keptWaiting: number;
  skipped: boolean;
}

export interface WaitOptions {
  ping: CliPing;
  interactive: boolean;
  /** Ask whether to keep waiting. The signal aborts the question with the outcome when one lands first. */
  ask(waitedMs: number, signal: AbortSignal): Promise<WaitChoice | undefined>;
  firstWaitMs?: number;
  extraWaitMs?: number;
}

export async function waitForFirstReply(opts: WaitOptions): Promise<FirstReplyWait> {
  const { ping, interactive, ask, firstWaitMs = FIRST_WAIT_MS, extraWaitMs = EXTRA_WAIT_MS } = opts;
  const start = Date.now();
  let replied: PingOutcome | undefined;
  const settled = ping.outcome.then((outcome) => (replied = outcome));
  let keptWaiting = 0;
  let windowMs = firstWaitMs;

  while (true) {
    const timer = sleep(windowMs);
    await Promise.race([settled, timer.done]);
    timer.cancel();
    if (replied) return { outcome: replied, keptWaiting, skipped: false };

    if (!interactive) {
      ping.stop();
      return { outcome: await ping.outcome, keptWaiting, skipped: false };
    }

    const asking = new AbortController();
    void settled.then((outcome) => asking.abort(outcome));
    const choice = await ask(Date.now() - start, asking.signal);
    // A reply that lands while the question is open wins over the answer.
    if (replied) return { outcome: replied, keptWaiting, skipped: false };
    if (choice === 'wait') {
      keptWaiting++;
      windowMs = extraWaitMs;
      continue;
    }
    ping.stop();
    const outcome = await ping.outcome;
    // Stopping can still turn up a reply or a failure the client had printed.
    return { outcome, keptWaiting, skipped: outcome.result === 'no_reply' };
  }
}

function sleep(ms: number): { done: Promise<void>; cancel(): void } {
  let timer: NodeJS.Timeout | undefined;
  const done = new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)));
  return { done, cancel: () => clearTimeout(timer) };
}
