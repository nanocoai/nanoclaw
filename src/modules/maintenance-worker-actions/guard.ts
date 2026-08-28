/**
 * Guard adapters for Maintenance Coordinator's routine actions -- the
 * module's catalog entries.
 *
 * Two shapes, both ALLOW-only (no hold): `maintenanceWorkerAction` for
 * anything a worker's own session does (status/time/completion/info --
 * none of these are consequential by themselves, they're capture/lookup),
 * gated to Maintenance Coordinator's own agent group; `maintenanceStatusQuery`
 * for Pepper's read-only status question, gated to Pepper's agent group.
 * Identity checked directly here since neither ever holds for a card.
 *
 * Ported verbatim from old commit 824318ff.
 */
import { ALLOW, DENY, defineGuardedAction, type GuardInput } from '../../guard/index.js';
import { MAINTENANCE_COORDINATOR_AGENT_GROUP_ID, PEPPER_AGENT_GROUP_ID } from './config.js';

function decideWorkerAction(input: GuardInput) {
  if (input.actor.kind !== 'agent') {
    return DENY('This is a container-originated action.');
  }
  if (input.actor.agentGroupId !== MAINTENANCE_COORDINATOR_AGENT_GROUP_ID) {
    return DENY('Only usable by Maintenance Coordinator.');
  }
  return ALLOW('Routine worker action -- capture or lookup only, no consequential effect.');
}

function decideStatusQuery(input: GuardInput) {
  if (input.actor.kind !== 'agent') {
    return DENY('This is a container-originated action.');
  }
  if (input.actor.agentGroupId !== PEPPER_AGENT_GROUP_ID) {
    return DENY('Only usable by Pepper.');
  }
  return ALLOW('Read-only status summary for Kirk.');
}

// No grantActionName on either: decide() only ever returns allow/deny, never hold.
export const maintenanceWorkerAction = defineGuardedAction({
  action: 'maintenance-worker-actions.worker-action',
  decide: decideWorkerAction,
});

export const maintenanceStatusQuery = defineGuardedAction({
  action: 'maintenance-worker-actions.status-query',
  decide: decideStatusQuery,
});
