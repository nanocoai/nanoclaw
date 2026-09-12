/**
 * Sandbox addresses follow the sandbox lifecycle.
 *
 * On a host with remote access enabled every named sandbox gets an address
 * of its own from the account (`<sandbox>.<name>.<zone>`), so a terminal
 * can land in it directly. The registration rides code mode's lifecycle
 * hooks: `onSandboxCreated` registers the name, `onSandboxRemoved` frees
 * it. Both are best effort by contract — a checkout that is not set up
 * with the account or the default sandbox (which is the account's own
 * address) leave a plain sandbox and never fail the verb. A service that
 * does not answer is tried again every minute until it does; a refusal is
 * final and, when it is the name (taken, reserved, invalid), loud: the
 * operator must hear it, since the sandbox exists without an address.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import { onSandboxCreated, onSandboxRemoved, SANDBOX_HOOKS_SEAM } from '../../../code-mode/hooks.js';
import { onHostShutdown } from '../../../host-lifecycle.js';
import { log } from '../../../log.js';
import { registerSandbox, unregisterSandbox, type SandboxAddressOutcome } from './sandboxes.js';

export const REMOTE_ADDRESS_HOOK = 'remote-address';

/**
 * How long the created hook waits for the account's answer before the
 * sandbox verb moves on. A refused name is worth a line at once; a slow
 * service is not worth holding the terminal for.
 */
export const ADDRESS_ANSWER_WAIT_MS = 4_000;

/** How long to wait before asking a service that did not answer again. */
export const ADDRESS_RETRY_MS = 60_000;

/** Names the account will not give an address: final, and the operator's to hear. */
const NAME_REFUSALS = new Set(['invalid_name', 'name_reserved', 'name_taken']);

/** Test seam: the timers the retry loop uses. */
export interface RetryTimers {
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
let timers: RetryTimers = { sleep: (ms, signal) => sleep(ms, undefined, signal ? { signal } : undefined) };
const inFlight = new Set<AbortController>();

/** End every pending retry: a waiting registration must not hold the process past shutdown. */
export function abortAddressRetries(): void {
  for (const controller of inFlight) controller.abort();
  inFlight.clear();
}

export function setAddressRetryTimersForTesting(next: RetryTimers | null): void {
  timers = next ?? { sleep: (ms, signal) => sleep(ms, undefined, signal ? { signal } : undefined) };
  abortAddressRetries();
}

function refusedName(sandbox: string, outcome: SandboxAddressOutcome): boolean {
  if (!outcome.code || !NAME_REFUSALS.has(outcome.code)) return false;
  log.error('Sandbox name refused for an address — the sandbox exists without an address of its own', {
    sandbox,
    code: outcome.code,
    hint: 'pick another name (ncl sandboxes new --name <name>) to reach it by address',
  });
  return true;
}

/**
 * Run `attempt` until it is done or refused; a service that did not answer
 * is asked again every ADDRESS_RETRY_MS. Resolves with the first final
 * outcome. The loop stops with the process (host shutdown aborts it).
 */
export async function untilAnswered(
  what: string,
  sandbox: string,
  attempt: () => Promise<SandboxAddressOutcome>,
): Promise<SandboxAddressOutcome> {
  const controller = new AbortController();
  inFlight.add(controller);
  try {
    for (let tries = 1; ; tries++) {
      const outcome = await attempt();
      if (outcome.done || !outcome.retryable) return outcome;
      if (tries === 1)
        log.warn(`Sandbox address ${what}: the account did not answer — retrying every minute`, { sandbox });
      try {
        await timers.sleep(ADDRESS_RETRY_MS, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        return outcome; // aborted: the host is going down
      }
      if (controller.signal.aborted) return outcome;
    }
  } finally {
    inFlight.delete(controller);
  }
}

onSandboxCreated(
  REMOTE_ADDRESS_HOOK,
  async (group) => {
    const registration = untilAnswered('registration', group.folder, () => registerSandbox(group.folder));
    const answer = await Promise.race([registration, sleep(ADDRESS_ANSWER_WAIT_MS, null)]);
    if (answer) {
      refusedName(group.folder, answer);
      return;
    }
    // The answer comes after the verb moved on: still loud, just late.
    registration.then((outcome) => refusedName(group.folder, outcome)).catch(() => {});
  },
  { seam: SANDBOX_HOOKS_SEAM },
);

onHostShutdown(() => abortAddressRetries());

onSandboxRemoved(
  REMOTE_ADDRESS_HOOK,
  async (group) => {
    // The rows are gone; the address is freed in the background, with the same patience.
    void untilAnswered('release', group.folder, () => unregisterSandbox(group.folder));
  },
  { seam: SANDBOX_HOOKS_SEAM },
);
