/**
 * Lease Manager write guard adapters — the module's catalog entries,
 * composed at the module edge (imported by ./index.ts).
 *
 * Decision is unconditional hold from the container path, same as self-mod:
 * a write to either workbook (production or the synthetic test one) always
 * needs admin approval -- the test target is lower-stakes but still real
 * enough (it exercises the real Excel COM writer) to card, not skip. The
 * "must be Lease Manager's own agent group" check is domain validation, not
 * a guard decision, so it lives in ./request.ts's precheck rather than here
 * (matching how self-mod keeps package-name validation out of its guard).
 *
 * The reset/teardown tool (./reset-test-workbook.ts) is deliberately NOT
 * guarded here -- it has no guarded action at all, registered unguarded in
 * index.ts, since it only ever restores a known-safe fictional baseline.
 *
 * Ported verbatim from old commit 59de60dc.
 */
import { DENY, HOLD, defineGuardedAction, type GuardInput } from '../../guard/index.js';

function decide(label: string) {
  return (input: GuardInput) => {
    if (input.actor.kind !== 'agent') {
      return DENY(`${label} is a container-originated action.`);
    }
    return HOLD(`${label} always requires admin approval from the container path`);
  };
}

export const leaseManagerWrite = defineGuardedAction({
  action: 'lease_manager_write.submit',
  grantActionName: 'lease_manager_write',
  decide: decide('lease_manager_write'),
});

export const leaseManagerWriteTest = defineGuardedAction({
  action: 'lease_manager_write_test.submit',
  grantActionName: 'lease_manager_write_test',
  decide: decide('lease_manager_write_test'),
});
