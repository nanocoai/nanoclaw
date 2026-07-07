# NanoClaw Database Architecture — Overview

Orientation for the data model: the three databases, how they fit together, and the invariants that hold across them. For table-level schemas, follow the links below.

- **[db-central.md](db-central.md)** — every table in `data/v2.db` (identity, wiring, approvals, Chat SDK state) plus the migration system.
- **[db-session.md](db-session.md)** — the per-session `inbound.db` + `outbound.db` pair, seq parity, and session folder layout.

Related: [architecture.md](architecture.md) for the high-level design; [api-details.md](api-details.md) for inbound/outbound message content shapes; [isolation-model.md](isolation-model.md) for channel-to-agent wiring modes.

---

## 1. The three databases

NanoClaw uses **three kinds of SQLite database**, all on the host filesystem:

| DB | Location | Writer | Readers | Purpose |
|----|----------|--------|---------|---------|
| **Central** | `data/v2.db` | host | host | Identity, permissions, routing, wiring — the admin plane |
| **Session inbound** | `data/v2-sessions/<agent_group_id>/<session_id>/inbound.db` | host | host (sync), container (read-only) | Host → container messages + routing projections |
| **Session outbound** | `data/v2-sessions/<agent_group_id>/<session_id>/outbound.db` | container | host (poll), container | Container → host messages + processing status |

**Single-writer rule.** Every SQLite file has exactly one writer. Host writes the central DB and every `inbound.db`; container writes only its own `outbound.db`. This eliminates write contention across the Docker/Apple Container mount boundary — SQLite locking across that boundary is unreliable.

**Everything is a message.** There is no IPC, stdin piping, or file watcher between host and container. The two session DBs are the sole IO surface. Heartbeat is a file `touch(2)` on `.heartbeat`, not a DB write.

**Journal mode.** Session DBs use `journal_mode = DELETE` (not WAL). Cross-mount WAL visibility is a bug farm; DELETE mode + open-write-close forces the page cache to flush so the other side sees changes.

---

## 2. Database map

```
data/
  v2.db                                   ← CENTRAL (host ↔ host)
  v2-sessions/
    <agent_group_id>/
      .claude-shared/                     ← shared Claude state for the agent group
      <session_id>/
        inbound.db                        ← host writes, container reads
        outbound.db                       ← container writes, host reads
        .heartbeat                        ← mtime touched by container
        inbox/<message_id>/               ← decoded user attachments
        outbox/<message_id>/              ← attachments the agent produced
```

Path helpers: `sessionDir()`, `inboundDbPath()`, `outboundDbPath()`, `heartbeatPath()` — all in `src/session-manager.ts`.

---

## 3. Central vs. session: what goes where

| Kind of data | Where | Why |
|--------------|-------|-----|
| Identities, roles, memberships | central | Stable, cross-session, rarely written |
| Channel wiring, routing rules | central | Admin plane |
| Destination ACL | central (+ projection per session) | Source of truth centrally; fast local lookup per session |
| Session registry (ids, status) | central | Host orchestrates lifecycle |
| Approvals & pending questions | central | Survive container restarts, admin-visible |
| Dropped-message audit | central | Global ops view |
| Inbound messages, retry state | session `inbound.db` | Per-session workload; host is sole writer |
| Outbound messages, agent state | session `outbound.db` | Container is sole writer; host polls |
| Delivery outcome | session `inbound.db` (`delivered`) | Host writes on success; container reads for edit targeting |
| Processing status | session `outbound.db` (`processing_ack`) | Container can't write to `inbound.db` |

Heuristic: if the value is a message, routing projection, or runtime ack, it goes per-session. Everything else is central.

---

## 4. Cross-mount visibility

Session DBs are bind-mounted into the container. A few rules you need to know before touching the DB code:

- **`journal_mode = DELETE`, not WAL.** WAL files don't reliably cross the mount and the container can read stale pages. DELETE mode forces each writer to flush the main file.
- **Open-write-close on the host.** Host-side writes to `inbound.db` open a connection, write, and close it. Keeping a handle open makes cached pages invisible to the container.
- **Container reads read-only.** The container opens `inbound.db` with `readonly: true` and never writes — all container→host state goes through `outbound.db` (see `processing_ack` in [db-session.md](db-session.md#52-processing_ack)).
- **Heartbeat is a file touch.** `.heartbeat` mtime is the liveness signal, not a DB column. A DB write per heartbeat would serialize behind other writers.

These rules are enforced by convention in `src/session-manager.ts` and `container/agent-runner/src/db/`. If you change how the DBs are opened, re-read that code first.

---

## 5. Design patterns at a glance

1. **Two-DB session split.** `inbound.db` and `outbound.db` each have one writer, one direction of flow — no cross-mount lock contention.
2. **Seq parity.** Even = host, odd = container. Disjoint namespace across both tables lets the agent reference any message by `seq` alone. Details in [db-session.md §3](db-session.md#3-sequence-numbering-invariant).
3. **Projection pattern.** `agent_destinations` and `session_routing` are projected from the central DB into each session's `inbound.db` on container wake — the container gets a fast, local read path without querying across the mount.
4. **Ack via reverse channel.** Container never writes to `inbound.db`. Status sync happens through `processing_ack` in `outbound.db`, which the host polls and reconciles.
5. **Heartbeat out of band.** File `touch` on `.heartbeat`, not a DB write, so liveness doesn't serialize behind other writers.
6. **Lazy session-DB migrations.** Central DB uses numbered migrations; per-session DBs use `IF NOT EXISTS` + ad-hoc `ALTER TABLE` helpers for older session folders.
7. **ACL = row existence.** `agent_destinations` membership is itself the permission — no separate `permissions` table.

---

## 6. Readers & writers — at a glance

| Table | DB | Writer(s) | Reader(s) |
|-------|----|-----------|-----------|
| `agent_groups` | central | `src/db/agent-groups.ts` | session resolver, delivery, router |
| `messaging_groups` | central | `src/db/messaging-groups.ts`, channel setup | router, delivery, session resolver |
| `messaging_group_agents` | central | `src/db/messaging-groups.ts` | router |
| `users` | central | `src/db/users.ts`, auth flows | permission checks |
| `user_roles` | central | `src/db/user-roles.ts` | `src/access.ts`, all permission gates |
| `agent_group_members` | central | `src/db/agent-group-members.ts` | membership checks |
| `user_dms` | central | `src/user-dm.ts` (`ensureUserDm`) | approval + pairing delivery |
| `sessions` | central | `src/db/sessions.ts`, `src/session-manager.ts` | delivery, sweep, container runner |
| `pending_questions` | central | `src/db/sessions.ts` (via `ask_user_question`) | container response matcher |
| `agent_destinations` | central | `src/db/agent-destinations.ts`, migration 004 backfill | `writeDestinations()`, delivery ACL |
| `pending_approvals` | central | `src/db/sessions.ts`, `src/onecli-approvals.ts` | admin-card delivery, sweep |
| `unregistered_senders` | central | `src/db/dropped-messages.ts` | ops tooling |
| `chat_sdk_*` | central | `src/state-sqlite.ts` | Chat SDK bridge |
| `schema_version` | central | `src/db/migrations/index.ts` | migration runner |
| `messages_in` | inbound | `src/db/session-db.ts` | `container/agent-runner/src/db/messages-in.ts` |
| `delivered` | inbound | `src/db/session-db.ts` (`markDelivered`) | container edit/reaction targeting |
| `destinations` | inbound | `writeDestinations()` in `src/session-manager.ts` | container routing / ACL |
| `session_routing` | inbound | `writeSessionRouting()` in `src/session-manager.ts` | container `send_message` defaults |
| `messages_out` | outbound | `container/agent-runner/src/db/messages-out.ts` | `src/delivery.ts` poll loop |
| `processing_ack` | outbound | `container/agent-runner/src/db/messages-in.ts` | `src/host-sweep.ts` (`syncProcessingAcks`) |
| `session_state` | outbound | `container/agent-runner/src/db/session-state.ts` | container on startup |
