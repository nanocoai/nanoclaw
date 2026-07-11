# Temporal ("Incognito") Sessions — Design

**Date:** 2026-07-11
**Branch:** `feature/temporal-session`
**Status:** Draft — pending review
**Type:** Design / spec

## 1. Goal

Add the ability to start a **temporal session**: a throwaway conversation that does **not** load the agent group's stored long-term memory, and whose own activity **never persists** to that memory. Think "incognito mode" for a NanoClaw agent.

Today every session for an agent group runs in the same shared group workspace and therefore always sees (and writes to) the group's accumulated long-term memory. There is no way to say "just this once, talk to me with a clean slate and forget it afterward."

## 2. Locked decisions

Confirmed with the requester before design:

| Axis | Decision |
|------|----------|
| **Trigger** | Chat command / prefix (e.g. `/incognito …`). Not an admin-only / ncl-only knob, not a permanent per-wiring setting. |
| **Isolation strength** | **Full incognito** — the agent cannot *read* prior long-term memory, **and** nothing it *writes* during the session persists. |
| **Continuity** | A **distinct throwaway session** with its own id + transcript. It maintains multi-turn continuity *within itself*, starts clean, and is discarded when it ends. The normal thread session is untouched. |
| **Scope** | **DMs only** (`is_group=0`). In a group chat the command is refused with a one-line note (see §5.3). Rationale in §5.3 / §9. |

## 3. Background — how long-term memory loads today (discovery)

All long-term memory lives in the **group dir** (`groups/<folder>/`), which is mounted **RW at `/workspace/agent`** and is **shared across every session** of that agent group. There is no per-session workspace isolation.

Memory reaches the agent through several surfaces:

| Surface | What it is | Entry into context | Reference |
|---|---|---|---|
| `CLAUDE.local.md` | Primary per-group memory | **Auto-loaded** by the Claude SDK via `settingSources: ['project','user','local']` — the `local` source is this file | `container/agent-runner/src/providers/claude.ts:421` |
| Ad-hoc workspace files | `customers.md`, `people.md`, project notes, etc. — the agent is *instructed* to create these in the workspace root and index them from `CLAUDE.local.md` | Read on demand by the agent; discoverable via `Glob`/`Read` | `container/CLAUDE.md` ("Memory" / "Workspace" sections) |
| `memory/` tree | Structured scaffold (`index.md`, `system/`, `memories/`, `data/`) for providers with `usesMemoryScaffold` | Scaffolded at boot; read on demand | `container/agent-runner/src/memory-scaffold.ts`, `index.ts:103` |
| `conversations/` | Archived past-session transcripts | Written by the PreCompact/rotation path; read on demand. Write path already env-overridable via `NANOCLAW_CONVERSATIONS_DIR` | `container/agent-runner/src/providers/claude.ts:225` |
| SDK transcript `.jsonl` | Within-session resume history (short-term, but stored per-**group**) | Loaded via `resume: input.continuation`. Lives under `/home/node/.claude`, which is mounted from the **per-group** `data/v2-sessions/<group>/.claude-shared` | `container-runner.ts:281,334` |

**Design-critical takeaway:** because the agent stores memory as *arbitrary files in the workspace root* (not just three well-known paths), "read isolation" cannot be achieved by hiding a fixed list of files. It requires giving the temporal session a **fresh, empty workspace** that contains only the operating instructions (persona, skills, shared base) and none of the accumulated memory.

There is currently **no** temporal / ephemeral / no-memory flag anywhere in the session, wiring, or container-config models.

## 4. Design overview

Two cooperating pieces:

1. **Host routing + lifecycle** — a `/incognito` command starts a distinct temporal session for the current thread; subsequent messages continue in it; `/incognito end` (or an idle timeout) tears it down and discards all its data. The normal thread session is never touched.
2. **Host spawn — ephemeral workspace ("M2")** — a temporal session's container is given a *fresh per-session workspace* at `/workspace/agent` (operating instructions only, no memory) and an isolated `/home/node/.claude`. All writes land in per-session ephemeral dirs that are deleted on teardown.

The container/agent-runner code needs **essentially no change** — because the temporal container simply sees a workspace with no memory in it, and all its writes go to ephemeral locations. (One optional addition: a one-line system-prompt note so the agent knows it's in a temporal session and won't promise to "remember" anything.)

```
Normal thread session ───────────────► group dir /workspace/agent (shared, persistent)
                                        + group /home/node/.claude (shared)

/incognito  ──► Temporal session ─────► fresh ephemeral /workspace/agent (instructions only)
              (own id, temporal=1)      + fresh ephemeral /home/node/.claude
                                        → both deleted on /incognito end or idle sweep
```

## 5. Trigger & routing

### 5.1 Commands (defaults; wording configurable)

| Command | Effect |
|---|---|
| `/incognito [first message]` | Start a fresh temporal session for this thread. Any text after the command becomes the first turn. If a temporal session is already active for the thread, it is discarded and a new one starts. |
| `/incognito end` (aliases `/endincognito`, `/exit`) | Close and **discard** the active temporal session; a short confirmation is delivered; routing reverts to the normal session. No-op (with a gentle note) if not in incognito. |
| _idle timeout_ | The host sweep auto-ends an idle temporal session (reuses the existing idle ceiling; see §8). |

Detection happens in the router **before** `gateCommand` and **before** session resolution, because the command changes *which session* the message routes to. The existing command gate (`command-gate.ts`) is unchanged — `/incognito` is consumed upstream and never reaches it or the container.

### 5.2 Routing rule (per inbound message, inside the fan-out)

For a message directed at `(agent, messagingGroup, thread)`:

0. **Group chat (`mg.is_group !== 0`)?** → incognito is not available. If the message is a `/incognito` command, reply with the DM-only note (§5.3) and do not route further; otherwise fall straight through to the normal path. Steps 1–3 below apply only in DMs.
1. **Start command?** → `destroyTemporalSession(...)` if one exists, then `resolveTemporalSession(...)` to create a fresh one; deliver the stripped remainder (if any) as the first turn; wake.
2. **End command?** → `destroyTemporalSession(...)`; deliver a confirmation to the real thread; do not route further.
3. **Active temporal session exists for this thread?** → route this message to it (multi-turn continuity).
4. **Otherwise** → existing normal `resolveSession(...)` path, unchanged.

"Incognito is active for this thread" is derived from the DB: an `active`, `temporal=1` session for `(agentGroupId, messagingGroupId, thread)`. This is durable — it survives a host restart, and the normal session is always recoverable.

### 5.3 Engagement & scope

- **DMs only.** Incognito is available only in direct messages (`mg.is_group === 0`). In a group chat, `/incognito` is refused with a one-line note (`🕶️ Incognito is only available in direct messages.`) delivered to the thread, and never creates a temporal session. Rationale: "incognito" implies a private, personal, throwaway chat, but a NanoClaw session is scoped to the *thread*, not the individual — so in a shared thread one member's `/incognito` would silently flip the agent into memory-free mode for *everyone*, appearing to "forget" shared context mid-conversation. Per-user incognito inside a shared thread would require user-scoped sessions (a much larger change NanoClaw doesn't model today) — out of scope. See §9.
- In a DM, a `/incognito` command **forces engagement** for the wired agent (it is a direct instruction), mirroring how a mention engages.
- No new privilege gate: incognito only *reduces* what the agent sees and never mutates persistent memory, so any sender already allowed to DM the agent may use it.

## 6. Session model & schema

### 6.1 `temporal` flag on sessions

Add a column so the normal and temporal sessions for the same `(group, mg, thread)` can **coexist** (the normal one holding history for when the user returns):

- `sessions.temporal INTEGER NOT NULL DEFAULT 0` — migration `src/db/migrations/0NN-temporal-sessions.ts` + `src/db/schema.ts`.
- `Session.temporal: 0 | 1` in `src/types.ts`.
- Any uniqueness/index on `(agent_group_id, messaging_group_id, thread_id)` must include `temporal` so both rows are legal.

### 6.2 Real `thread_id`, not synthetic — for correct delivery

`writeSessionRouting` (`session-manager.ts:173`) derives the reply address from `session.thread_id`. Therefore a temporal session must store the **real** `thread_id` (so replies land back in the user's chat) and be disambiguated from the normal session **only** by `temporal=1`. (A synthetic `system:incognito:…` thread — the pattern task sessions use — would break reply delivery, so it is explicitly rejected here.)

### 6.3 New session-manager surface

- `resolveTemporalSession(agentGroupId, messagingGroupId, threadId)` → finds/creates the `temporal=1` session for the real thread (mirrors `resolveSession`, sets `temporal=1`).
- `destroyTemporalSession(agentGroupId, messagingGroupId, threadId)` → closes the session, kills its container, and deletes its session folder + ephemeral workspace + ephemeral `.claude`.
- Normal lookups (`findSessionForAgent`, `findSessionByAgentGroup`) filter to `temporal=0` so routing, sweeps, and delivery of normal traffic never pick up a temporal session by accident.

## 7. Container spawn — ephemeral workspace (approach "M2")

When `session.temporal === 1`, `buildMounts` / `spawnContainer` (`src/container-runner.ts`) diverge from the normal path:

1. **Fresh workspace base.** Instead of mounting the group dir at `/workspace/agent`, mount a per-session ephemeral dir (e.g. `data/v2-sessions/<group>/<session>/agent-ephemeral/`) RW at `/workspace/agent`.
2. **Operating instructions only.** Compose the group's CLAUDE.md **into the ephemeral base** (parameterize `composeGroupClaudeMd(group, targetDir?)` to accept an output dir; it still reads persona/skills/MCP config from the real group). Result: the ephemeral workspace has `CLAUDE.md`, `.claude-shared.md` (symlink → `/app/CLAUDE.md`, valid in-container), `.claude-fragments/`, and `container.json` — and **nothing else** (no `CLAUDE.local.md`, no `memory/`, no `conversations/`, no ad-hoc files).
   - This sidesteps the dangling-symlink problem of nested-mounting individual instruction files: because the host owns the ephemeral dir, it recreates the same container-path symlinks the group dir uses.
3. **Isolated SDK state.** Give the temporal container a fresh per-session `/home/node/.claude` (seeded with the same skill symlinks + `settings.json` the shared `.claude-shared` gets) — or, minimally, delete the temporal session's `.jsonl` on teardown. Recommended: fully isolate it so the incognito transcript never lands in the group's shared `.claude`.
4. **Env marker.** Pass `NANOCLAW_TEMPORAL=1` so (optionally) the runner can append a system-prompt note, and so the spawn is self-describing in logs.
5. **Additional mounts** declared in container config (explicit external resource dirs) are **kept** — they are declared resources, not accumulated agent memory. Only the group *workspace memory* is isolated.

Because everything memory-related (scaffold, `conversations/`, transcript, any file the agent writes) now resolves inside ephemeral dirs, **no agent-runner code change is required** for isolation. The only optional container change is the system-prompt note.

## 8. Teardown & cleanup

A temporal session is discarded when:

- The user sends `/incognito end` (or alias) → `destroyTemporalSession(...)` runs immediately.
- The host sweep detects it idle → same teardown. Reuse the existing idle machinery in `src/host-sweep.ts` (which already auto-closes "spent" system/task sessions, `host-sweep.ts:170`, `updateSession(..., {status:'closed'})`). A temporal session with no running container past the idle ceiling (`ABSOLUTE_CEILING_MS`, or a shorter temporal-specific TTL) is closed and deleted.

`destroyTemporalSession` must:
1. `killContainer(session.id, 'temporal-end')` if running.
2. `updateSession(session.id, {status:'closed'})` then `deleteSession(session.id)`.
3. `rm -rf` the session folder (`data/v2-sessions/<group>/<session>/`), which contains the ephemeral workspace, ephemeral `.claude`, and both session DBs.

Result: no residue in `groups/<folder>/`, no transcript in the group's `.claude`, nothing to leak into a future session.

## 9. Rejected alternatives

- **M1 — shadow specific paths.** Keep the group dir mounted; nested-mount empty dirs/files over `CLAUDE.local.md`, `memory/`, `conversations/`. *Rejected:* it still leaks the agent's ad-hoc workspace files (`customers.md`, `people.md`, project notes) that are also long-term memory. Does not deliver the "full incognito" isolation that was chosen.
- **Soft read-only suppression.** Only drop the `local` settingSource + a system-prompt "don't touch memory" instruction. *Rejected:* smallest change (~10 lines), but relies on the agent obeying, and writes can still land in the group dir. Fails the "nothing persists" requirement.
- **Synthetic `system:incognito:` thread id.** *Rejected:* breaks `writeSessionRouting` reply delivery (§6.2).
- **Per-wiring / ncl-only trigger.** *Rejected by product decision:* the chat-command trigger was chosen for on-demand, per-conversation use.
- **Supporting incognito in group chats.** *Rejected:* a session is thread-scoped, not user-scoped, so one member's `/incognito` would flip the shared thread to memory-free mode for everyone — a footgun, and "incognito" has no private meaning in a public thread anyway. True per-user incognito would need user-scoped sessions, a much larger change. DMs only (§5.3).

## 10. Integration points (file-by-file)

**Host — new:**
- `src/incognito.ts` (new) — command parsing (`parseIncognitoCommand(text)` → `start | end | none`, stripped body) + the routing decision helper.

**Host — changed:**
- `src/router.ts` — call the incognito helper early in the fan-out; route to `resolveTemporalSession` / trigger `destroyTemporalSession`; force engagement on the start command; strip the command prefix from the delivered body.
- `src/session-manager.ts` — `resolveTemporalSession`, `destroyTemporalSession`; temporal-aware routing writes.
- `src/db/sessions.ts` — `temporal` column reads/writes; `findSessionForAgent` / `findSessionByAgentGroup` exclude `temporal=1`; a `findTemporalSession(...)` lookup.
- `src/db/schema.ts` + `src/db/migrations/0NN-temporal-sessions.ts` — add the column + index.
- `src/types.ts` — `Session.temporal`.
- `src/container-runner.ts` — temporal branch in `buildMounts`/spawn (ephemeral workspace + `.claude`, `NANOCLAW_TEMPORAL=1`).
- `src/claude-md-compose.ts` — accept an optional output dir so composition can target the ephemeral workspace.
- `src/host-sweep.ts` — idle auto-teardown for temporal sessions.

**Container — optional:**
- `container/agent-runner/src/index.ts` (or `destinations.ts` addendum builder) — if `NANOCLAW_TEMPORAL=1`, append a short "this is a temporal session; nothing here persists" note to the system prompt.

## 11. Testing

**Host (vitest):**
- Command parsing: `/incognito`, `/incognito hello`, `/incognito end`, aliases, non-commands.
- Routing: start creates a `temporal=1` session with the **real** thread_id; follow-ups continue in it; `end` closes+deletes it and reverts; the normal session is never selected while incognito, and is intact afterward.
- DM-only guard: `/incognito` in a group chat (`is_group=1`) does **not** create a temporal session and returns the DM-only note; a non-command message in a group is unaffected and routes normally.
- Mount set: temporal spawn mounts the ephemeral workspace (not the group dir), contains only instruction artifacts, sets `NANOCLAW_TEMPORAL=1`, and isolates `/home/node/.claude`.
- Teardown: `destroyTemporalSession` kills the container, closes+deletes the session, and removes the session folder; idle sweep triggers the same.
- Delivery: a temporal session's reply routing resolves to the real `(channel, platform, thread)`.

**Container (bun:test):**
- If the system-prompt note is added: addendum reflects temporal mode when `NANOCLAW_TEMPORAL=1`, and is absent otherwise.

## 12. Risks & open questions

- **`/home/node/.claude` isolation cost.** Fully isolating SDK state per temporal session means seeding skill symlinks + `settings.json` into a fresh dir at spawn. If that proves heavy, the fallback is: keep the shared `.claude` mount but delete the temporal session's `.jsonl` on teardown. Decision can be made during implementation; both satisfy "nothing persists," the fresh-dir option is cleaner.
- **Command wording.** `/incognito` vs `/private` vs `/fresh`; `end`/`/exit`/`/endincognito`. Defaults above; easy to change before implementation.
- **Non-Claude providers.** M2 is provider-agnostic (the workspace is simply empty of memory). `usesMemoryScaffold` providers will scaffold into the ephemeral workspace — correct, and discarded on teardown. No special-casing needed.

## 13. Out of scope

- Persisting or "promoting" anything learned during a temporal session back into long-term memory.
- A per-wiring "always incognito" channel setting (possible future add; the `temporal` flag + spawn path would be reused).
- Group-chat incognito, in any form — whole-thread or per-user (§9). Would require user-scoped sessions if ever revisited.
- Changing how normal sessions store or load memory.
