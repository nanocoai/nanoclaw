# NanoCo Gateway Ask adapter

Protocol v2 deliberately resets only the host's Gateway approval bridge rows
and cursor when upgrading from v1. Those rows cannot truthfully acquire the new
typed presentation after the fact. Approver bindings and all unrelated host
state are preserved; the restarted Gateway establishes a new epoch and
reconciles new approvals from its snapshot.

NanoClaw consumes approval protocol `nanoco.approval.v2` from NanoCo Gateway.
The nine JSON examples in `fixtures/nanoco-approval-protocol/v2/` are kept
byte-identical with the Gateway fixture set and pinned by NanoClaw tests.

The adapter reuses the deployment-control mTLS identity already configured for
session-channel provisioning. It never places the deployment certificate or
private key in an agent container. At startup it performs the protocol recovery
order: fetch the deployment-scoped snapshot, commit approvals and the snapshot
cursor to SQLite, then connect SSE from that cursor. A non-contiguous event or
`resync_required` response starts that sequence again.

## Authority and state

`nanoco_gateway_approvals` is separate from NanoClaw's generic
`pending_approvals` continuation path. A Gateway approval is evidence for one
live Gateway request, never a local grant. Its durable local states are
`pending -> decided -> delivered`, with `expired` and `cancelled` terminal
states. Human decisions and adapter-unavailable outcomes are committed before
their authenticated PUT and retried after restart until the Gateway
acknowledges them.

`nanoco_approver_bindings` has one structurally unique row for each immutable
IdP `(issuer, subject)` and names one authenticated NanoClaw platform user.
Email addresses and messaging handles are delivery attributes only. Missing or
unreachable bindings produce the authenticated `unavailable` outcome; no admin
picker or fallback is called.

The card question ID is a short SHA-256-derived value persisted before channel
delivery. The attempt itself is also persisted first. A successful platform
return records `card_delivered_at`, even when the platform has no message ID.
After restart, a delivered pending card is reused. The narrow crash window with
an attempted but unconfirmed card fails unavailable instead of risking a
duplicate card.

The card renderer consumes only the protocol's typed `presentation` fields.
It has no Gmail, provider, or HTTP-method switch: text, list, and long-text
values are rendered consistently for reads and writes. The Gateway materializes
those bounded values from the exact held request; NanoClaw persists the complete
presentation as immutable delivery evidence before attempting the card. The
primary card omits raw request URLs, bounds long-text previews, and keeps a
human-readable deadline. A module-owned question-render resolver restores that
same semantic card context before compact button callbacks are dispatched, so
the terminal card retains the decided action after restart.

## Configuration

The adapter uses the existing host-only values:

- `NANOCO_DEPLOYMENT_ID`
- `NANOCO_GATEWAY_CONTROL_URL`
- `NANOCO_GATEWAY_CONTROL_SERVER_NAME`
- `NANOCO_GATEWAY_CA`
- `NANOCO_DEPLOYMENT_CERT`
- `NANOCO_DEPLOYMENT_KEY`

All must be configured together. Approver bindings are populated by the
governance/identity integration through the narrow `replaceApproverBinding`
database seam; this PR intentionally does not implement Governance policy or
identity synchronization.
