## Approvals module

Admin-gated approval flow for agent self-modification and OneCLI credential access. Lives in `src/modules/approvals/`.

### Two flows

**Agent-initiated (DB-backed, fire-and-forget).** The container writes a `system`-kind outbound row with one of two actions — `install_packages`, `add_mcp_server`. The module's delivery-action handlers validate, route to the right approver's DM, and persist a `pending_approvals` row. When the admin clicks a button, the registered response handler applies the change (config update → image rebuild if needed → container kill) and notifies the agent via system chat.

**OneCLI credential (long-poll).** The OneCLI gateway holds an HTTP connection open when it needs credential approval. `onecli-approvals.ts` delivers a card, persists a `pending_approvals` row (action = `onecli_credential`), and waits on an in-memory Promise that resolves on click or expiry timer. Survives host restart: the startup sweep retains the original card, replaces its buttons with a timeout status, and drops the row.

### Wiring

- **Delivery actions:** `install_packages`, `add_mcp_server` via `registerDeliveryAction`.
- **Response handler:** single handler claims both agent-initiated and OneCLI approvals. OneCLI is tried first (in-memory Promise); falls through to `pending_approvals` lookup.
- **Adapter-ready hook (`onDeliveryAdapterReady`):** starts the OneCLI manual-approval handler once the delivery adapter is set.
- **Shutdown hook (`onShutdown`):** stops the OneCLI handler.

### Tables

`pending_approvals` (created by `module-approvals-pending-approvals.ts`). Columns for both DB-backed and OneCLI-tracking rows. Not dropped on uninstall — approvals in flight aren't lost on reinstall.

### Core integration

The module depends on host-side infra but does not reach into core decision paths beyond the registered hooks:
- `buildAgentGroupImage`, `killContainer` from container-runner (image rebuilds)
- `updateContainerConfig` from container-config (apt/npm/mcp edits)
- `pickApprover`, `pickApprovalDelivery` from access
- `getDeliveryAdapter` in request-approval.ts and the adapter-ready callback in OneCLI handler

No core code imports from this module. Removing it: delete `src/modules/approvals/`, remove the import from `src/modules/index.ts`. Delivery actions will log "Unknown system action"; button clicks on approval cards will log "Unclaimed response". Stale rows remain in `pending_approvals` until reinstall or manual cleanup.
