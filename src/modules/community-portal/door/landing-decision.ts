/**
 * Where an approved connection lands — pure, so the table is testable:
 *
 *   stream                         → decision
 *   none                           → refuse (the door only admits streams the host relays)
 *   target { sandbox }             → attach that sandbox (cold ones wake on attach; a missing
 *                                     one fails with "no longer exists")
 *   target { account }, exists     → attach the account's default sandbox
 *   target { account }, missing    → create it through `sandboxes new`, which lands attached
 *
 * `SSH_ORIGINAL_COMMAND` `ls` or `list` prints the sandbox list instead; any
 * other command is refused with usage.
 */
import type { DoorStream } from './target-map.js';

export type LandingDecision =
  | { verb: 'attach' | 'new'; name: string }
  | { verb: 'list' }
  | { verb: 'refuse'; reason: string; code: 1 | 2 };

export const LANDING_USAGE = 'usage: ssh <address> [ls]  — no command lands in the sandbox; "ls" lists sandboxes';

export function decideLanding(
  stream: DoorStream | undefined,
  existingSandboxes: readonly string[],
  originalCommand?: string,
): LandingDecision {
  if (!stream) {
    return {
      verb: 'refuse',
      reason: 'This connection has no target; the door only admits streams the host relays.',
      code: 1,
    };
  }
  const command = originalCommand?.trim();
  if (command) {
    if (command === 'ls' || command === 'list') return { verb: 'list' };
    return { verb: 'refuse', reason: LANDING_USAGE, code: 2 };
  }
  const { account, sandbox } = stream.target;
  if (sandbox) return { verb: 'attach', name: sandbox };
  if (!account) return { verb: 'refuse', reason: 'This connection names no account.', code: 1 };
  return existingSandboxes.includes(account) ? { verb: 'attach', name: account } : { verb: 'new', name: account };
}
