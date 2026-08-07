/**
 * The action catalog — the enforcement boundary.
 *
 * An action either is defined here (and every consult passes its decision)
 * or cannot be consulted at all: guard() takes the GuardedAction VALUE
 * returned by defineGuardedAction, so the wiring between a consult site and
 * its decide fn is a symbol reference the compiler checks. A dropped
 * module-edge import or a typo'd action name is a build error, not a
 * runtime fail-open — there is no lookup that can miss.
 *
 * Definitions are still recorded by name so the catalog can be enumerated:
 * the conformance test pairs every holding action with its registered
 * approval handler, and duplicate names are refused at definition time
 * (grants match on the name).
 */
import type { GuardDecision, GuardInput } from './types.js';
import type { PendingApproval } from '../types.js';

export interface GuardedActionSpec {
  /** Dotted action name, e.g. 'roles.grant', 'agents.create', 'a2a.send'. */
  action: string;
  /**
   * Today's structural checks for this action, verbatim — the only source of
   * allow. Runs on every consult, including approved replays (a grant
   * satisfies a hold, never a deny).
   */
  decide: (input: GuardInput) => GuardDecision;
  /**
   * The pending_approvals.action its holds resolve through — a grant is only
   * accepted when its row carries this action. Omit for actions that can
   * never be held (deny/allow-only decisions).
   */
  grantActionName?: string;
  /**
   * Extra domain binding between a grant and the replayed input (e.g. the
   * a2a target must match the held message). Runs in addition to the
   * grantActionName + live-row checks.
   */
  grantCoversRequest?: (grant: PendingApproval, input: GuardInput) => boolean;
}

declare const guardedActionBrand: unique symbol;
/**
 * A defined guarded action — only defineGuardedAction can mint one. The
 * brand makes the type nominal: a hand-rolled { action, decide } object
 * does not typecheck at a consult site, and fails the runtime check too.
 */
export type GuardedAction = Readonly<GuardedActionSpec> & { readonly [guardedActionBrand]: true };

const defined = new Map<string, GuardedAction>();
const minted = new WeakSet<object>();

export function defineGuardedAction(spec: GuardedActionSpec): GuardedAction {
  if (defined.has(spec.action)) {
    throw new Error(`guarded action "${spec.action}" is already defined — action names are the catalog key`);
  }
  const def = Object.freeze({ ...spec }) as GuardedAction;
  minted.add(def);
  defined.set(spec.action, def);
  return def;
}

/**
 * Runtime backstop for callers outside the type system (plain JS, casts):
 * only values minted by defineGuardedAction pass — guard() denies the rest.
 */
export function isGuardedAction(value: unknown): value is GuardedAction {
  return typeof value === 'object' && value !== null && minted.has(value);
}

export function listGuardedActions(): GuardedAction[] {
  return [...defined.values()].sort((a, b) => a.action.localeCompare(b.action));
}
