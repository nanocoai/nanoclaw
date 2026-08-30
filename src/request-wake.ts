/**
 * The wake seam.
 *
 * Every "make this session's container run" call site migrates from
 * importing `wakeContainer` directly to `requestWake`, giving wake intent a
 * single chokepoint so it can later be recorded durably (`wake_signals` in
 * src/db/coordination.ts) and served event-driven. The implementation below
 * is a pure delegation — byte-equivalent to calling `wakeContainer` — and
 * MUST stay that way until the durable rows become authoritative: no
 * logging, no signal writes, no behavior.
 */
import { requestWakeForPlane } from './modules/process-split/cross-plane.js';
import type { Session } from './types.js';

/**
 * Why the session should be running. Later recorded on the wake-signal row;
 * extend the union as call sites migrate.
 */
export type WakeReason =
  | 'inbound-message'
  | 'due-message'
  | 'container-restart'
  | 'self-mod-apply'
  | 'agent-created'
  | 'interactive'
  | 'cli'
  | 'approval-response'
  | 'adoption';

export async function requestWake(session: Session, reason: WakeReason): Promise<boolean> {
  // Process-split overlay: the split gateway records durable wake intent;
  // the controller and the un-split host keep the trunk delegation verbatim.
  return requestWakeForPlane(session, reason);
}
