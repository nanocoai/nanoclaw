/**
 * Guard adapter for report_maintenance_issue — the module's catalog entry.
 *
 * ALLOW only for Maintenance Coordinator's own agent group, DENY
 * everyone else — checked directly here since there's no hold/approval
 * card for the report itself (capturing that a worker reported something
 * isn't consequential; the consequential step is Kirk's own decision,
 * which goes through the separate, always-required maintenance_decision
 * card in ../maintenance-decisions/). A report never authorizes anything
 * on its own.
 *
 * Ported verbatim from old commit 824318ff.
 */
import { ALLOW, DENY, defineGuardedAction, type GuardInput } from '../../guard/index.js';
import { MAINTENANCE_COORDINATOR_AGENT_GROUP_ID } from './config.js';

function decide(input: GuardInput) {
  if (input.actor.kind !== 'agent') {
    return DENY('report_maintenance_issue is a container-originated action.');
  }
  if (input.actor.agentGroupId !== MAINTENANCE_COORDINATOR_AGENT_GROUP_ID) {
    return DENY('report_maintenance_issue is only usable by Maintenance Coordinator.');
  }
  return ALLOW('Recording a worker-reported issue -- capture only, no consequential action taken by this step.');
}

// No grantActionName: decide() above only ever returns allow/deny, never hold.
export const reportMaintenanceIssue = defineGuardedAction({
  action: 'report_maintenance_issue.submit',
  decide,
});
