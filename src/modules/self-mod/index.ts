/**
 * Self-modification module — admin-approved container mutations.
 *
 * Optional tier. Depends on the approvals default module for the request/
 * handler plumbing and on the guard for the decision. On install the module
 * registers:
 *   - Its guard-catalog entries (./guard.ts): unconditional hold from the
 *     container path.
 *   - Two guard-wrapped delivery actions (install_packages, add_mcp_server):
 *     validation runs as the wrapper's precheck, the hold builders card the
 *     admin, and the handler bodies (./apply.ts) run only on allow — i.e. on
 *     an approved replay:
 *       install_packages → update container_configs, rebuild image, kill
 *         container (next wake respawns on the new image), schedule a
 *         verify-and-report follow-up prompt.
 *       add_mcp_server → update container_configs, kill container. No image
 *         rebuild — bun runs TS directly, so the new MCP server is wired
 *         by the next container start.
 *   - Two approval handlers that re-enter the wrapped actions with the
 *     approval row as the grant (one replay semantics — the guard re-checks
 *     the structural checks live).
 *
 * Without this module: the MCP tools in the container still write outbound
 * system messages with these actions, but delivery logs "Unknown system
 * action" and drops them. Admin never sees a card; nothing changes.
 */
import { reenterGuardedDeliveryAction, registerDeliveryAction } from '../../delivery.js';
import { notifyAgent, registerApprovalHandler } from '../approvals/index.js';
import { applyAddMcpServer, applyInstallPackages } from './apply.js';
import { selfModAddMcpServer, selfModInstallPackages } from './guard.js';
import {
  requestAddMcpServerHold,
  requestInstallPackagesHold,
  validateAddMcpServer,
  validateInstallPackages,
} from './request.js';

registerDeliveryAction('install_packages', applyInstallPackages, {
  guardAction: selfModInstallPackages,
  precheck: validateInstallPackages,
  requestHold: requestInstallPackagesHold,
  onDeny: (_content, session, reason) => notifyAgent(session, `install_packages denied: ${reason}`),
});
registerDeliveryAction('add_mcp_server', applyAddMcpServer, {
  guardAction: selfModAddMcpServer,
  precheck: validateAddMcpServer,
  requestHold: requestAddMcpServerHold,
  onDeny: (_content, session, reason) => notifyAgent(session, `add_mcp_server denied: ${reason}`),
});

registerApprovalHandler('install_packages', reenterGuardedDeliveryAction('install_packages'));
registerApprovalHandler('add_mcp_server', reenterGuardedDeliveryAction('add_mcp_server'));
