## Approvals module

Admin-gated approval flow for agent self-modification and provider-owned credential access. Lives in `src/modules/approvals/`.

### Two flows

**Agent-initiated (DB-backed, fire-and-forget).** The container writes a `system`-kind outbound row with one of two actions — `install_packages`, `add_mcp_server`. The module's delivery-action handlers validate, route to the right approver's DM, and persist a `pending_approvals` row. When the admin clicks a button, the registered response handler applies the change (config update → image rebuild if needed → container kill) and notifies the agent via system chat.

**Gateway credential.** Not this module's. The selected gateway provider translates its native approval events, and `src/gateway-approval-coordinator.ts` — core, not a module — owns the human flow, its `pending_approvals` rows, and its response handler. This module supplies only the shared `pickApprover` / `pickApprovalDelivery` primitives it uses. See [docs/gateway-seam.md](../../../docs/gateway-seam.md).

### Wiring

- **Delivery actions:** `install_packages`, `add_mcp_server` via `registerDeliveryAction`.
- **Response handler:** the gateway coordinator's handler is registered first (`prepend`) and claims gateway approvals; this module's handler claims the DB-backed ones.
- **Lifecycle:** the gateway coordinator is started and stopped by `src/index.ts`, not by this module.

### Tables

`pending_approvals` (created by `module-approvals-pending-approvals.ts`). Not dropped on uninstall, so approvals in flight are not lost on reinstall.

### Core integration

The module depends on host-side infra but does not reach into core decision paths beyond the registered hooks:
- `buildAgentGroupImage`, `killContainer` from container-runner (image rebuilds)
- `updateContainerConfig` from container-config (apt/npm/mcp edits)
- `pickApprover`, `pickApprovalDelivery` from access
- `getDeliveryAdapter` in request-approval.ts

No core code imports from this module. Removing it: delete `src/modules/approvals/`, remove the import from `src/modules/index.ts`. Delivery actions will log "Unknown system action"; button clicks on approval cards will log "Unclaimed response". Stale rows remain in `pending_approvals` until reinstall or manual cleanup.
