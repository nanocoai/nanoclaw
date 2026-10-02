/**
 * Approvals module — admin approval primitive + response plumbing.
 *
 * Default-tier module. Ships with main. Other modules depend on it by
 * importing `requestApproval` / `registerApprovalHandler` from this module.
 *
 * Registers:
 *   - A response handler that claims pending_approvals rows and dispatches
 *     to whatever module registered for the row's `action` string. Also
 *     dispatches only generic module approvals.
 *   - A message-interceptor (via ./reason-capture.js) that captures an admin's
 *     one-line reply after they click "Reject with reason…".
 *
 * Exposes `sweepAwaitingReasonRejects` for the host sweep to finalize ghosted
 * reject-with-reason holds (re-exported here, which also loads reason-capture
 * so its interceptor registers).
 *
 * Self-mod flows (install_packages, add_mcp_server) moved out to
 * `src/modules/self-mod/` in PR #7 — they now register delivery actions
 * + approval handlers via this module's public API.
 */
import { registerResponseHandler } from '../../response-registry.js';
import { handleApprovalsResponse } from './response-handler.js';

// Public API re-exports so consumers import from the module root.
export { requestApproval, registerApprovalHandler, notifyAgent } from './primitive.js';
export type { ApprovalHandler, ApprovalHandlerContext, RequestApprovalOptions } from './primitive.js';
// Host-sweep hook for ghosted "Reject with reason…" holds. The re-export also
// loads reason-capture.js, registering its message-interceptor on import.
export { sweepAwaitingReasonRejects } from './reason-capture.js';

registerResponseHandler(handleApprovalsResponse);
