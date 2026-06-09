/**
 * Approvals module — admin approval primitive + response plumbing.
 *
 * Default-tier module. Ships with main. Other modules depend on it by
 * importing `requestApproval` / `registerApprovalHandler` from this module.
 *
 * Registers:
 *   - A response handler that claims pending_approvals rows and dispatches
 *     to whatever module registered for the row's `action` string. Also
 *     resolves in-memory OneCLI credential approvals.
 *   - An adapter-ready callback that starts the OneCLI manual-approval handler
 *     once the delivery adapter is set.
 *   - A shutdown callback that stops the OneCLI handler cleanly.
 *
 * Self-mod flows (install_packages, add_mcp_server) moved out to
 * `src/modules/self-mod/` in PR #7 — they now register delivery actions
 * + approval handlers via this module's public API.
 */
import { USE_NATIVE_CREDENTIAL_PROXY } from '../../config.js';
import { onDeliveryAdapterReady } from '../../delivery.js';
import { registerResponseHandler, onShutdown } from '../../response-registry.js';
import { handleApprovalsResponse } from './response-handler.js';
import { startOneCLIApprovalHandler, stopOneCLIApprovalHandler } from './onecli-approvals.js';

// Public API re-exports so consumers import from the module root.
export { requestApproval, registerApprovalHandler, notifyAgent } from './primitive.js';
export type { ApprovalHandler, ApprovalHandlerContext, RequestApprovalOptions } from './primitive.js';

registerResponseHandler(handleApprovalsResponse);

// OneCLI manual-approval handler long-polls the gateway. Skip wiring when
// using the native credential proxy — there's no gateway to poll.
if (!USE_NATIVE_CREDENTIAL_PROXY) {
  onDeliveryAdapterReady((adapter) => {
    startOneCLIApprovalHandler(adapter);
  });

  onShutdown(() => {
    stopOneCLIApprovalHandler();
  });
}
