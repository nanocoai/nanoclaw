/**
 * guard() — the one decision function every privileged action consults.
 *
 * The decision is the action's decide fn — today's code checks,
 * defined per action at the module edges. The consult site holds the
 * GuardedAction value itself (defineGuardedAction), so there is no name
 * lookup and no fail-open path for an unknown action: an unwired consult is
 * a compile error, and a value that didn't come from defineGuardedAction is
 * denied at runtime. Policy-as-data (tighten-only rule sources composing
 * with the decision) is deliberately deferred — a generalized rules table
 * can arrive later, with its first operator-visible consumer; until then
 * the one policy table (agent_message_policies) is consulted inside
 * a2a.send's decide.
 *
 * Grants: an approved replay carries the verified approval row. A valid
 * grant (live pending row whose action matches the entry's approval action,
 * plus any domain binding) satisfies a hold — the human already decided —
 * but NEVER a deny: the checks re-run live, so approve-then-revoke
 * no longer executes. A grant that is present but invalid fails closed to
 * deny (no second card).
 *
 * The guard itself fails closed: a throwing decide denies.
 */
import { getPendingApproval } from '../db/sessions.js';
import { log } from '../log.js';
import { isGuardedAction, type GuardedAction } from './guard-actions.js';
import { ALLOW, DENY, type GuardDecision, type GuardInput } from './types.js';

export function guard(action: GuardedAction, input: GuardInput): GuardDecision {
  if (!isGuardedAction(action)) {
    // JS-level backstop — the branded type already forbids this. A
    // hand-rolled object must not carry a decide fn never vetted at
    // definition time.
    log.error('Guard consulted with an undefined action — failing closed', {
      action: (action as { action?: unknown } | null)?.action,
    });
    return DENY('guard consulted with an undefined action (failing closed)');
  }

  let decision: GuardDecision;
  try {
    decision = action.decide(input);
  } catch (err) {
    log.error('Guard evaluation threw — failing closed', { action: action.action, err });
    return DENY('guard failure (failing closed)');
  }

  if (!input.grant || decision.effect !== 'hold') {
    // A grant never loosens a deny (the checks re-run live), and a
    // grant on an already-allowed action is a no-op.
    return decision;
  }

  // An invalid grant on a replay is a refusal, not a fresh hold — approved
  // replays must execute exactly once.
  if (grantSatisfies(action, input)) {
    return ALLOW(`hold satisfied by approval ${input.grant.approval_id}`);
  }
  return DENY('replay carried an invalid or mismatched grant');
}

function grantSatisfies(action: GuardedAction, input: GuardInput): boolean {
  const grant = input.grant;
  if (!grant || !action.grantActionName) return false;
  if (grant.action !== action.grantActionName) return false;
  // The row must still be live — resolution deletes it, so a grant can only
  // execute once and a fabricated row object doesn't pass.
  const live = getPendingApproval(grant.approval_id);
  if (!live || live.action !== action.grantActionName) return false;
  if (action.grantCoversRequest && !action.grantCoversRequest(grant, input)) return false;
  return true;
}
