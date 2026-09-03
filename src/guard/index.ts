/**
 * Guard — the privileged-action decision seam.
 *
 * One decision function (guard.ts) and a definition-derived action
 * catalog (guard-actions.ts). Consults carry the GuardedAction value returned by
 * defineGuardedAction — never a name to look up — so mis-wiring is a build
 * error, not a runtime fail-open.
 * Domain-free leaf: domain decisions are defined at the domain modules' edges.
 */
export { guard } from './guard.js';
export {
  defineGuardedAction,
  isGuardedAction,
  listGuardedActions,
  type GuardedAction,
  type GuardedActionSpec,
} from './guard-actions.js';
export {
  ALLOW,
  DENY,
  GuardDenyError,
  HOLD,
  isUnguarded,
  unguarded,
  type GuardActor,
  type GuardDecision,
  type GuardInput,
  type Unguarded,
} from './types.js';
