# Agent mailbox seam migration

NanoClaw now routes per-session mailbox access through matching semantic
registries in the Node host and Bun runner. The open-source composition still
selects SQLite, and existing `inbound.db` and `outbound.db` files remain valid.

## Detect affected customizations

Search custom source and installed skills for removed raw session helpers and
mailbox calls or public types whose shape changed:

```bash
rg -n "openInboundDb|withInboundDb|openOutboundDb|openOutboundDbRw" src .claude/skills container/agent-runner/src
rg -n "writeSessionMessage|writeSessionRouting|writeOutboundDirect|writeMessageOut|createScheduledTask|restartAgentGroupContainers|createAgentFromTemplate" src .claude/skills container/agent-runner/src
rg -n "setContainerToolInFlight|clearContainerToolInFlight|clearStaleProcessingAcks|touchHeartbeat|DeliveryActionHandler|PostDeliveryHook" src .claude/skills container/agent-runner/src
rg -n "(trigger|onWake)\\s*:\\s*[01]\\b|kind\\s*:\\s*string" src .claude/skills container/agent-runner/src
```

Imports of the raw helpers from `src/session-manager.ts` require migration.
Review custom calls from the second search and ensure their enclosing function
awaits the result. Built-in matches are already migrated.

The moved and narrowed symbols map old to new as follows:

| Before | After |
| --- | --- |
| `setContainerToolInFlight()` in the old `db/connection.ts` | import the seam-neutral `setContainerToolInFlight()` shim from `db/container-state.ts` or `db/index.ts` |
| `clearContainerToolInFlight()` in the old `db/connection.ts` | import the seam-neutral `clearContainerToolInFlight()` shim from `db/container-state.ts` or `db/index.ts` |
| `clearStaleProcessingAcks()` in the old `db/connection.ts` | import the seam-neutral `clearStaleProcessingAcks()` shim from `db/container-state.ts` or `db/index.ts` |
| `touchHeartbeat()` in the old `db/connection.ts` | `touchHeartbeat()` moved to `heartbeat.ts` and remains re-exported from `db/index.ts` |
| `DeliveryActionHandler(content, session, inDb)` | `DeliveryActionHandler(content, session)`; open a short `withMailboxSession()` inside the handler only when it needs mailbox state |
| `PostDeliveryHook` message fields `platform_id`, `channel_type`, `thread_id`, `in_reply_to` | use `platformId`, `channelType`, `threadId`, `inReplyTo` |
| `writeSessionMessage({ trigger: 0 | 1, onWake: 0 | 1 })` | pass booleans: `trigger: false | true`, `onWake: false | true` |
| inbound `kind: string` | use the closed `InboundKind` set: `chat`, `chat-sdk`, `task`, `webhook`, or `system` |

## Why the interface changed

Session callers previously opened SQLite handles directly, making SQLite's
schema, paths, and lifecycle part of every caller. The mailbox seam gives the
selected implementation ownership of opening, refreshing, flushing, and
closing session storage. That ownership requires an asynchronous operation
boundary even though the default remains SQLite.

Two rules follow from that ownership:

- **Reads never provision.** `AgentMailbox.exists()` is a side-effect-free
  probe. `session()` operates only on storage already authorized by
  `prepare()`; it never creates storage by itself. Core read paths use
  `withExistingMailboxSession()` and treat a missing mailbox as empty.
- **Never nest same-key sessions.** An implementation may serialize
  `session()` per key while loading and committing its state. Opening another
  `session()` for the same session from inside an action (including via
  helpers like `writeSessionMessage`) can deadlock the implementation.
  `withMailboxSession` always throws on same-key nesting. Finish the open
  session, then call the helper.
- **Sync methods are snapshot-scoped.** The synchronous `MailboxSession`
  methods operate on implementation-managed session state; their effects must
  be durable only once `session()` resolves. The asynchronous writes
  (`insertMessage`, `insertTask`, `writeDirect`) must be durable when their
  own promise resolves — the host wakes containers on the strength of them.

## Update custom host modules

Replace raw database access with the semantic operation that expresses the
module's intent:

```ts
// Before: SQLite-specific.
const db = openInboundDb(agentGroupId, sessionId);
try {
  // query or update the session mailbox
} finally {
  db.close();
}

// After: works with the registered mailbox.
await withMailboxSession(agentGroupId, sessionId, (mailbox) => {
  return mailbox.countDueMessages();
});
```

Import `withMailboxSession` from `src/session-manager.ts`. Available semantic
operations are declared in `src/mailbox/types.ts`. If custom SQL performs an
operation absent from that contract, keep the customization explicitly
SQLite-only by importing the low-level opener from `src/mailbox/sqlite/session-db.ts`, or
add the smallest semantic operation required by every selected mailbox.

Add `await` to mailbox writes and propagate `async` through custom callers:

```ts
await writeSessionMessage(agentGroupId, sessionId, message);
await writeSessionRouting(agentGroupId, sessionId);
await writeOutboundDirect(agentGroupId, sessionId, message);
```

In the runner, continue using the compatibility modules under
`container/agent-runner/src/db/`, but await `writeMessageOut()`. New code may
use `getAgentMailbox().operations` directly. `getAgentMailbox().run()` scopes
a logical unit of mailbox work (the MCP server wraps each tool call in it);
note that the built-in poll loop and compatibility modules call `operations`
outside `run()`, so a replacement mailbox must keep `operations` functional
without an enclosing `run()` — treat `run()` as an optional scoping hint, not
a gate.

`AgentMailbox.start()` may receive `null` only during the brief upgrade window
where the shared runner source updates before the host restarts and writes its
session context. SQLite accepts that legacy sentinel; an implementation that
requires context should reject `null` explicitly.

## Compose one mailbox implementation

There is one composition story in both runtimes: the real module barrel imports
`mailbox/compose.ts`, and a capability skill replaces the registration inside
that file. Keep the barrel and entrypoint imports unchanged. Never append a
second mailbox registration import—the registry intentionally rejects it.

## Keep the canonical model storage-neutral

`src/mailbox/model.ts` defines the exact records exchanged with mailbox
implementations. Its values are JSON-native: camel-case fields, booleans, UTC
ISO-8601 timestamps, and nonnegative safe integers. A storage implementation
must translate its native representation at its boundary—for example SQLite
`0`/`1` flags and snake-case columns—and validate the translated record before
returning it.

Canonical records are intentionally flat: fields contain JSON primitives or
`null`, while kind-specific structured payloads remain encoded in `content`.
The shared parser rejects nested objects and arrays so a future field cannot
silently bypass exact-field validation.

Serialization metadata belongs to the implementation that needs it and is not
part of the canonical mailbox record. Each implementation should test its
contract lifecycle alongside representation-specific round trips so its
translations cannot silently drift.

## Verify the migration

Build both runtimes and run their tests:

```bash
pnpm run build
pnpm test
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
cd container/agent-runner && bun test
```

With the default composition, send a message through a real channel and verify
that the existing session's `inbound.db` receives it and `outbound.db` receives
the reply. Re-run the searches above and confirm every affected custom write is
awaited or deliberately SQLite-only.

## Roll back

No stored-data migration occurs. Return NanoClaw and custom modules to the
previous revision, rebuild the host and agent image, and restart the service.
The same SQLite session files remain usable after rollback.
