/**
 * Agent-to-agent module — inter-agent messaging and on-demand agent creation.
 *
 * Registers its guard-catalog entries (./guard.js) and one guard-wrapped
 * delivery action (`create_agent`) — `create_agent` writes central-DB state,
 * so the guard's agents.create decision holds confined (non-global) groups
 * for admin approval while trusted global-scope groups create directly; the
 * approval handler re-enters the wrapped action carrying the approval row as
 * its grant. The sibling `channel_type === 'agent'` routing path is NOT a
 * system action — core `delivery.ts` dispatches into `./agent-route.js` via
 * a dynamic import when it sees `msg.channel_type === 'agent'`.
 *
 * Host integration points:
 *   - `src/container-runner.ts::spawnContainer` dynamically imports
 *     `./write-destinations.js` on every wake (guarded by `hasTable('agent_destinations')`).
 *   - `src/delivery.ts::deliverMessage` dynamically imports `./agent-route.js`
 *     when `msg.channel_type === 'agent'`.
 *
 * Without this module: `agent_destinations` table absent ⇒ container-runner
 * skips destination projection, ACL check in delivery skips, `create_agent`
 * system action logs "Unknown system action", `channel_type='agent'` messages
 * throw because the module isn't installed.
 */
import { reenterGuardedDeliveryAction, registerDeliveryAction } from '../../delivery.js';
import { notifyAgent, registerApprovalHandler } from '../approvals/index.js';
import { A2A_MESSAGE_GATE_ACTION } from './agent-route.js';
import { createAgent, requestCreateAgentHold, validateCreateAgent } from './create-agent.js';
import { agentsCreate } from './guard.js';
import { applyA2aMessageGate } from './message-gate.js';

registerDeliveryAction('create_agent', createAgent, {
  guardAction: agentsCreate,
  precheck: validateCreateAgent,
  requestHold: requestCreateAgentHold,
  onDeny: (_content, session, reason) => notifyAgent(session, `create_agent denied: ${reason}`),
});
registerApprovalHandler('create_agent', reenterGuardedDeliveryAction('create_agent'));

registerApprovalHandler(A2A_MESSAGE_GATE_ACTION, applyA2aMessageGate);
