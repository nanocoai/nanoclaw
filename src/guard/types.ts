/**
 * Guard vocabulary — the decision seam every privileged action passes.
 *
 * The guard is a domain-free leaf: this module may import the DB read layer,
 * config, log, and shared types — never src/cli/* or src/modules/*. Domain
 * knowledge (what an action's decide fn checks) arrives via
 * definition: domain modules call defineGuardedAction (guard-actions.ts) at
 * their module edges and pass the returned value to every consult and
 * registration site — the wiring is a symbol reference the compiler checks.
 */
import type { PendingApproval } from '../types.js';

/** Who is attempting the action. Mirrors the CLI CallerContext + click identities. */
export type GuardActor =
  | { kind: 'host' }
  | { kind: 'agent'; agentGroupId: string; sessionId?: string }
  | { kind: 'human'; userId: string }
  | { kind: 'system' };

export interface GuardInput {
  actor: GuardActor;
  /** Domain resource reference, e.g. { from, to } for a2a.send. */
  resource?: Record<string, string>;
  /** Action arguments — what the card summarizes and rules may later match on. */
  payload: Record<string, unknown>;
  /**
   * Verified approval row carried by an approved replay. A valid grant
   * satisfies a hold (the human already decided) but never a deny — the
   * structural checks re-run live on every replay.
   */
  grant?: PendingApproval | null;
}

const unguardedBrand = Symbol('unguarded');
/**
 * A registration that deliberately carries no guard. Where a registry takes
 * a declaration (delivery actions), omission is not representable —
 * registration requires either a guard spec or this marker, so the decision
 * to run unguarded is visible, and justified, in the diff that registers
 * the handler. The reason travels with the registration;
 * `grep "unguarded("` is the complete inventory.
 */
export type Unguarded = { readonly reason: string; readonly [unguardedBrand]: true };

export function unguarded(reason: string): Unguarded {
  return Object.freeze({ reason, [unguardedBrand]: true as const });
}

/**
 * The one runtime discriminator for guard declarations. The brand symbol is
 * module-private, so `unguarded()` is the only mint — a look-alike
 * `{ reason }` object (or a guard spec that someday grows a `reason` field)
 * doesn't pass.
 */
export function isUnguarded(decl: object): decl is Unguarded {
  return unguardedBrand in decl;
}

export type GuardDecision =
  | { effect: 'allow'; reason: string }
  | { effect: 'hold'; reason: string; approverUserId?: string }
  | { effect: 'deny'; reason: string };

export const ALLOW = (reason: string): GuardDecision => ({ effect: 'allow', reason });
export const DENY = (reason: string): GuardDecision => ({ effect: 'deny', reason });
/**
 * approverUserId names an exclusive approver for the hold (the a2a policy
 * row's named approver). Absent, the hold goes to the approvals primitive's
 * default chain (scoped admins → global admins → owners).
 */
export const HOLD = (reason: string, approverUserId?: string): GuardDecision => ({
  effect: 'hold',
  reason,
  approverUserId,
});

/**
 * A guard deny travelling as an exception — for flows whose entry point
 * signals refusal by throwing (the a2a route). Catching it lets a caller
 * distinguish "the guard refused, as designed" (report to the requester,
 * log a warning) from a real runtime failure (crash path, stack trace).
 */
export class GuardDenyError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'GuardDenyError';
  }
}
