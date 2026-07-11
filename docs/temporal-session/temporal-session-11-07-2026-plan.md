# Plan: Temporal ("Incognito") Sessions

## Status — closed out 2026-07-11

All milestones **[DONE]** on `feature/temporal-session` (one commit each, sequential).

| Milestone | Status | Commit |
|---|---|---|
| M1 — schema + temporal flag | [DONE] | `feat(sessions): add temporal flag + temporal-aware lookups` |
| M2 — lifecycle helpers | [DONE] | `feat(sessions): temporal session lifecycle helpers` |
| M3 — memory-free spawn | [DONE] | `feat(container): memory-free spawn for temporal sessions` |
| M4 — /incognito routing | [DONE] | `feat(router): /incognito DM command routing` |
| M5 — idle teardown + runner note | [DONE] | `feat(sweep): idle temporal teardown + agent-runner incognito note` |
| M6 — integration tests + docs | [DONE] | `test(incognito): end-to-end routeInbound integration + docs` |

**Verification:** host `tsc --noEmit` clean; `vitest run` = 774 passed. The only failing
tests are 7 pre-existing `scripts/q.test.ts` cases that `spawnSync('pnpm', …)` — `pnpm` is
absent from this shell's PATH (only `corepack pnpm` works), unrelated to this change.

**Key decisions / deviations from the plan:**
- `Session.temporal` is **optional** (`temporal?: number`), not required — the DB column
  defaults to 0 and is always present on rows read back; `createSession` coalesces a missing
  value to 0. Avoided churning ~20 pre-existing test `Session` literals (surgical-changes rule).
- Lifecycle helpers live in a **new `src/temporal-session.ts`** (not `session-manager.ts`) to
  avoid an import cycle (container-runner already imports `sessionDir` from session-manager).
- `destroyTemporalSession` closes the row **synchronously**, deferring only the container kill
  + folder `rm -rf` to the container's exit — so a re-`/incognito` can't reuse a dying session.
- Incognito control notes (start/end/DM-only) deliver **immediately** via `deliverSessionMessages`
  (idempotent, re-entry-guarded) rather than waiting up to 60s for the sweep.
- **Not run in this environment:** container `bun test` + `tsc` for the one agent-runner change
  (a guarded system-prompt note) — `bun` isn't installed here. Change mirrors the existing
  `destinations.test.ts` pattern; unit tests added.
- **Not done (per user request):** the PR was not opened; the branch is left ready.

## Context

NanoClaw agents always run in their group's shared workspace (`/workspace/agent`, the
`groups/<folder>/` dir), so every session reads and writes the group's accumulated
**long-term memory** — `CLAUDE.local.md`, ad-hoc files the agent creates in the workspace
root (`customers.md`, `people.md`, …), the `memory/` scaffold, `conversations/` archives,
and the SDK transcript. There is no way to have a throwaway conversation that ignores that
memory and leaves no trace.

This adds an **incognito mode**: a `/incognito` chat command (DMs only) starts a distinct,
memory-free session that keeps its own multi-turn continuity, then is discarded on
`/incognito end` or after idle. The normal session is never touched.

The full design (decisions, rejected alternatives, rationale) lives in
`docs/temporal-session/temporal-session-11-07-2026-design.md`.

**Locked decisions:** trigger = `/incognito` chat command (stop: `/incognito end`, aliases
`/exit`, `/endincognito`); isolation = full read+write incognito; continuity = distinct
throwaway session; scope = **DMs only**; SDK transcript = fully isolated per session.

**Key architectural choice:** the temporal session stores the **real** `thread_id` + real
`messaging_group_id`, disambiguated from the normal session by a new `temporal=1` flag — NOT
a synthetic `system:incognito:` thread. Required because `writeSessionRouting`
(`src/session-manager.ts:173`) derives the reply address from `session.thread_id` +
`session.messaging_group_id`; a synthetic thread would break delivery back to the chat.
No unique constraint exists on `(agent_group_id, messaging_group_id, thread_id)`
(`src/db/migrations/001-initial.ts`), so `temporal=0` and `temporal=1` rows coexist legally.

**Isolation approach ("fresh workspace"):** rather than hiding a fixed set of memory paths
(which leaks the ad-hoc files the agent creates in the workspace root), a temporal container
gets a *fresh, empty* `/workspace/agent` containing only operating instructions
(persona/skills/shared base) — no memory of any kind — plus its own fresh `/home/node/.claude`.
Both live under the session folder and are `rm -rf`'d on teardown. Because the workspace is
empty of memory and all writes fall into ephemeral dirs, the container/agent-runner needs only
one tiny optional change (a system-prompt note).

---

## Branching & workflow (plan-guidelines)

- **Strategy: A/B — one branch, one PR.** All milestones commit sequentially onto the existing
  `feature/temporal-session` branch (already cut from `main`); a single PR opens at the end via
  the `pr-mr-prepare` skill. Milestones are dependent and share state (sessions → session-manager
  → container-runner → router → sweep), so they run **sequentially** — no parallel worktrees.
- **Per milestone:** implement steps → write/run **unit tests** alongside (`testing-standards`)
  → run the **`code-quality-pipeline`** skill → commit. Ask before opening the PR.
- **Test levels:** host is **backend-only (no UI) → e2e/Playwright is skipped**. Unit tests carry
  breadth (every branch/edge); one **integration** milestone covers the routing wiring end-to-end
  on a real test DB (`initTestDb` + `runMigrations`, the `src/host-core.test.ts` pattern). All test
  entities use **random IDs** (`crypto.randomUUID()` / `Date.now()` suffix).

## Pre-implementation (first actions, once out of plan mode)

1. **Save this plan** to `docs/temporal-session/temporal-session-11-07-2026-plan.md` (plan-guidelines
   cardinal rule — plan on disk before any code). It's currently only in the plan-mode scratch file.
2. **Commit the design doc** `docs/temporal-session/temporal-session-11-07-2026-design.md` (written
   during brainstorming, not yet committed) to `feature/temporal-session`.

---

## Milestone 1 — Session schema + temporal flag

Add the `temporal` column and make normal routing/lookups ignore temporal rows.

- **`src/db/migrations/020-sessions-temporal.ts`** (new): `ALTER TABLE sessions ADD COLUMN
  temporal INTEGER DEFAULT 0;` (mirror `018-approvals-approver-user-id.ts`). Register in
  `src/db/migrations/index.ts` (import + append to `migrations`).
- **`src/db/schema.ts`**: add `temporal INTEGER DEFAULT 0` to the `sessions` CREATE TABLE (keep
  the reference schema in sync).
- **`src/types.ts`**: add `temporal: number; // 0 | 1` to `Session` (raw-row cast → no mapper change).
- **`src/db/sessions.ts`**:
  - `createSession` — add `temporal` to the INSERT columns + `@temporal` value.
  - Add `AND temporal = 0` to `findSession`, `findSessionForAgent`, `findSessionByAgentGroup`,
    `findSystemSession`, `findTaskSessions`.
  - Add `findTemporalSession(agentGroupId, messagingGroupId, threadId)` — `findSessionForAgent`
    shape but `AND temporal = 1` (handle the `thread_id IS NULL` branch).
  - Leave unchanged (must see temporal rows): `getActiveSessions`, `getRunningSessions`,
    `getSession`/`updateSession`/`deleteSession`.
- **`src/session-manager.ts`**: set `temporal: 0` on the `Session` literals in `resolveSession`
  and `resolveTaskSession`.

**Unit tests (`src/db/sessions.test.ts` or similar):** with random ids, insert a `temporal=1`
and a `temporal=0` session for the same `(group, mg, thread)`; assert `findSessionForAgent`
returns only the normal one and `findTemporalSession` only the temporal one; assert the other
filtered lookups exclude `temporal=1`; assert `getActiveSessions` returns both.
**Code-quality-pipeline:** run the `code-quality-pipeline` skill on the milestone diff before done.
**Verify:** `pnpm run build`; `pnpm test`.

## Milestone 2 — Temporal session lifecycle helpers

- **`src/session-manager.ts`**:
  - `resolveTemporalSession(agentGroupId, messagingGroupId, threadId, sessionMode)` — mirrors
    `resolveSession` (same `lookupThreadId` rule) but `temporal: 1`; reuse `findTemporalSession`,
    `createSession`, `initSessionFolder`.
  - `destroyTemporalSession(session: Session)` — if running,
    `killContainer(session.id, 'temporal-end', onExit)` (`src/container-runner.ts` supports
    `onExit`); in the callback (or immediately if not running): `updateSession(status:'closed')`,
    `deleteSession(id)`, `fs.rmSync(sessionDir(agentGroupId, id), { recursive:true, force:true })`.

**Unit tests:** `resolveTemporalSession` creates a `temporal=1` row + folder and is idempotent
(second call reuses); `destroyTemporalSession` closes+deletes the row and removes the folder;
not-running vs running paths. Follow the mock-`DATA_DIR` + `initSessionFolder` pattern in
`src/session-manager.test.ts`; random ids.
**Code-quality-pipeline:** run before done. **Verify:** `pnpm test`.

## Milestone 3 — Temporal container spawn (fresh workspace + isolated .claude)

Branch the spawn on `session.temporal === 1` in **`src/container-runner.ts`**.

- **Parameterize `composeGroupClaudeMd`** (`src/claude-md-compose.ts`) with an optional output dir:
  writes (`CLAUDE.md`, `.claude-shared.md` symlink, `.claude-fragments/`, `CLAUDE.local.md`) go to
  the target dir; persona (`readGroupPersona`) + container config (`getContainerConfig`) still read
  from the real group. Default target = group dir (unchanged behavior).
- **`buildMounts`** temporal branch:
  - Ephemeral workspace at `sessionDir/agent-ephemeral/`: compose instructions into it, copy
    `container.json`; mount RW at `/workspace/agent` **instead of** the group dir; no group-memory
    mounts (no `CLAUDE.local.md`, `memory/`, `conversations/`, ad-hoc files).
  - Ephemeral `/home/node/.claude` at `sessionDir/claude-ephemeral/`: write `DEFAULT_SETTINGS_JSON`
    (reuse from `src/group-init.ts`), `mkdir skills/`, `syncSkillSymlinks(...)`; mount RW at
    `/home/node/.claude` instead of the shared `.claude-shared`.
  - Everything else identical (session DBs, `/app/src`, `/app/skills`, `/app/CLAUDE.md`, additional
    + provider mounts). Ephemeral dirs sit under the session folder so they persist across turns and
    are removed by `destroyTemporalSession`.
- **`buildContainerArgs`**: when `session.temporal`, push `-e NANOCLAW_TEMPORAL=1` (after `TZ`, ~L443).

**Unit tests:** `buildMounts` for a temporal session yields the `agent-ephemeral` + `claude-ephemeral`
host paths (not group dir / shared `.claude-shared`) and args include `NANOCLAW_TEMPORAL=1`; a normal
session is byte-for-byte unchanged; `composeGroupClaudeMd(group, tmpDir)` writes instructions into
`tmpDir` and not the group dir.
**Code-quality-pipeline:** run before done. **Verify:** `pnpm test`; manual spawn → container sees an
empty workspace (no `CLAUDE.local.md`).

## Milestone 4 — `/incognito` command routing (DM-only)

- **`src/incognito.ts`** (new): `parseIncognitoCommand(content): { kind:'start'|'end'|'none';
  body:string }` — parse via the JSON `.text` shape `safeParseContent` uses; recognize `/incognito`,
  `/incognito end`, `/exit`, `/endincognito`; return the prefix-stripped `body`.
- **`src/router.ts` — inside `deliverToAgent`, before `resolveSession` (line 470)** for `chat`/`chat-sdk`:
  - Incognito command **and `mg.is_group !== 0`** → `writeOutboundDirect` the DM-only note (to the
    normal session, resolved for delivery); `return`.
  - `mg.is_group === 0`:
    - `start` → `destroyTemporalSession` any existing, `resolveTemporalSession`; non-empty `body` →
      `writeSessionMessage` the stripped body (rewrite content JSON `.text`) `trigger:1` + wake
      (reuse the existing `startTypingRefresh` + `wakeContainer` block); empty → `writeOutboundDirect`
      a "🕶️ Incognito on" note to the temporal session. `return`.
    - `end` → resolve the normal session, `writeOutboundDirect` an "Incognito off" note to it, then
      `destroyTemporalSession`. `return`.
    - plain message → if `findTemporalSession` returns an active one, route THIS message to it; else
      fall through to the normal path unchanged.

Reuse: `safeParseContent`, `writeOutboundDirect`, `writeSessionMessage`, `writeSessionRouting`, the
deliver-address block, the typing/`wakeContainer` block (all already in `deliverToAgent`).

**Unit tests:** `parseIncognitoCommand` permutations (`/incognito`, `/incognito hi`, `/incognito end`,
`/exit`, `/endincognito`, non-commands, leading whitespace, casing).
**Code-quality-pipeline:** run before done. **Verify:** `pnpm test`.

## Milestone 5 — Idle auto-teardown + agent-runner note

- **`src/host-sweep.ts`**: per-session sweep — for `session.temporal === 1`, if
  `!isContainerRunning(session.id)` and idle beyond `TEMPORAL_IDLE_MS` (default `ABSOLUTE_CEILING_MS`,
  from `last_active ?? created_at`), call `destroyTemporalSession(session)`. `getActiveSessions`
  already returns temporal sessions.
- **`container/agent-runner/src/`** (optional, small): when `process.env.NANOCLAW_TEMPORAL === '1'`,
  append a one-line note to the system-prompt addendum (`buildSystemPromptAddendum` in
  `destinations.ts`, called from `index.ts`): *"This is a temporal/incognito session — nothing here
  persists; do not claim to remember it later."*

**Unit tests:** host — an idle, not-running temporal session is torn down by the sweep decision; a
fresh or running one is not (extend `src/host-sweep.test.ts` decision-logic pattern, random ids).
Container — `bun test`: addendum includes the note iff `NANOCLAW_TEMPORAL=1`.
**Code-quality-pipeline:** run before done. **Verify:** `pnpm test`; `bun test` +
`pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`.

## Milestone 6 — Integration tests + docs

- **Integration tests (`src/*.test.ts`, `initTestDb` + `runMigrations`, `host-core.test.ts` pattern,
  random ids, mocked `container-runner`):** drive `routeInbound` for a DM:
  - `/incognito` → a `temporal=1` session exists with the real thread_id, normal session untouched,
    a wake/confirmation lands in the temporal session's `messages_out`.
  - follow-up plain message → routed to the temporal session (not the normal one).
  - `/incognito end` → temporal row + folder gone, "Incognito off" note in the normal session's
    `messages_out`, normal session intact.
  - `/incognito` in a group (`is_group=1`) → no temporal session created, DM-only note emitted.
- **Docs:** flip the design doc "Status" to implemented; add a short `/incognito` usage blurb where
  user-facing commands are documented.

**Code-quality-pipeline:** run the final holistic pass over the whole diff before the PR.
**Verify:** `pnpm run build`; full `pnpm test` + `bun test` green.

---

## Phase 3 — Close-out

- Mark each milestone/step `[DONE]`/`[SKIPPED]`/`[DEFERRED]` in the `docs/` plan file with reasons;
  record key decisions + verification results.
- Update the root `CLAUDE.md` (keep < 100 lines): note the `/incognito` DM command, the `sessions.temporal`
  flag, and the temporal-spawn path — pointing to the design doc for detail. Then run the
  `claude-md-management:claude-md-improver` skill to validate (or do it manually + note the skip if the
  plugin isn't installed).

## Phase 4 — QA handover

Backend-only, so this is the sole live pass. After merge/assembly, hand to the **`qa-engineer`** skill —
adapted to NanoClaw (no HTTP API): drive real DM traffic through a channel and inspect session DBs +
delivered replies rather than curl. Handoff bundle: this plan, the `/incognito` behavior + DM-only scope,
how to run the host + reach a DM channel, and two identities (to confirm group-chat rejection + that one
user's incognito is thread-scoped). Green-path: start → multi-turn → end, memory-isolation
(no group memory referenced; `groups/<folder>/` untouched; temporal session folder gone). Break-it:
`/incognito` in a group, `/exit` with no active session, rapid start/end, idle teardown. Gate on the
verdict; convert confirmed findings into committed unit/integration tests per `testing-standards`; record
the verdict in the plan file.

## Out of scope

Promoting anything learned in incognito back into memory; a per-wiring "always incognito" setting; any
group-chat incognito (would need user-scoped sessions); changes to how normal sessions load memory.
