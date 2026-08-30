/**
 * Claim readiness push (D18, ISSUES open #5 / C9) — the subscriber the
 * service's events exist for.
 *
 * The whoami acceptance's single worst ergonomic was a claiming agent polling
 * `envs get` blind every ~11s from claim to active, while the host KNEW the
 * moment the state machine flipped. This module closes that gap: every
 * terminal transition of an env whose row names a waiting session —
 * claiming→active, claiming→failed, and a later active→failed — is pushed
 * into that session as a system chat message.
 *
 * The transport is deliberately NOT new: `notifyAgent` is the exact path the
 * approvals machinery answers a held command on ("you are notified either
 * way") — a session-dir message write plus a container wake, which mid-turn
 * delivery hands to a waiting agent. One notification mechanism, two callers.
 *
 * Layering: this is a HOST module riding the service's event seam. Drivers
 * never learn a session exists (DriverClaimSpec has no field to leak one
 * through), and the service itself only records WHO waits — reaching them is
 * this file's whole job. Exactly-once is the state machine's own discipline,
 * not bookkeeping here: `settleReady`/`failEnv` fire one event per terminal
 * transition and none on re-adoption of an already-settled env, so the push
 * count is the transition count — across restarts and resumeClaim included.
 */
import { getSession } from '../db/sessions.js';
import { log } from '../log.js';
import { notifyAgent } from '../modules/approvals/index.js';

import type { DevEnvEvent, DevEnvService, EnvSnapshot } from './service.js';
import { devEnvFailureDetail, type DevEnvFailure } from './types.js';

/** Injectable for tests; production rides the approvals session-message path. */
export type ClaimPushDeliver = (sessionId: string, text: string) => Promise<void>;

/**
 * The production transport: resolve the recorded session and speak on the
 * same system-message channel approvals use. A session that no longer exists
 * is a skip, never an error — the row and `envs get` still hold the truth,
 * and the poll path owes nobody an apology.
 */
export async function deliverClaimPushToSession(sessionId: string, text: string): Promise<void> {
  const session = await getSession(sessionId);
  if (!session) {
    log.warn('Dev-env: claim push skipped — claiming session no longer exists', { sessionId });
    return;
  }
  await notifyAgent(session, text);
}

/**
 * Subscribe the push to a service's events. Returns the unsubscribe, like
 * `onEvent` itself. Wired in index.ts BEFORE `adopt()`, so a claim that
 * settles during adoption — including one failed because its instance did not
 * survive the restart — still reaches the agent that armed it.
 */
export function wireClaimReadinessPush(
  service: DevEnvService,
  deliver: ClaimPushDeliver = deliverClaimPushToSession,
): () => void {
  return service.onEvent((event) => {
    const text = pushText(event);
    if (!text || !event.env.claimantSessionId) return;
    // Fire-and-forget with its own catch: emit() isolates throwing listeners,
    // but an async rejection would escape that net.
    void deliver(event.env.claimantSessionId, text).catch((error) => {
      log.warn('Dev-env: claim push not delivered', { envId: event.env.envId, error: String(error) });
    });
  });
}

/** The push body, or null for events that owe nobody a message (release is the caller's own act). */
function pushText(event: DevEnvEvent): string | null {
  if (event.kind === 'env-ready') return readyText(event.env);
  if (event.kind === 'env-failed') return failedText(event.env, event.failure);
  return null;
}

/** stamp@version for registry-realized claims, bare id for code-provided — renderEnv's convention. */
function stampRef(env: EnvSnapshot): string {
  return `${env.stampId}${env.stampVersion === null ? '' : `@v${env.stampVersion}`}`;
}

function readyText(env: EnvSnapshot): string {
  const endpoints = Object.entries(env.endpoints)
    .map(([name, addr]) => `${name}=${addr}`)
    .join(' ');
  const access = Object.entries(env.access)
    .map(([name, path]) => `${name}=${path}`)
    .join(' ');
  // What the agent needs NEXT rides the push itself; the get command is for
  // everything else, not a required second hop.
  return [
    `Dev env ${env.envId} is active (stamp ${stampRef(env)}).`,
    endpoints && `endpoints: ${endpoints}`,
    access && `access: ${access}`,
    `Full status: ncl envs get ${env.envId}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function failedText(env: EnvSnapshot, failure: DevEnvFailure): string {
  // The reason travels ON the push (#20's recorded why) — a failure message
  // that says only "failed" would re-open the hole that work closed.
  const detail = devEnvFailureDetail(failure);
  return `Dev env ${env.envId} failed (stamp ${stampRef(env)}) — ${failure.kind}${detail ? `: ${detail}` : ''}`;
}
