# feat(scheduling): per-task missed-run policy for recurring tasks

Closes #2398

## Summary

Gives each recurring task an explicit policy for what happens when its scheduled period is missed, instead of always firing late and jumping to the next future slot.

- **Problem**: one implicit rule lost every period between a stale occurrence and "now" — right for a morning briefing, wrong for audit rolls and time-sensitive reviews.
- **Fix**: store a catch-up policy on the task content envelope (cloned with recurrence, no session-DB migration) and honor it in the host sweep / re-arm path.
- **Out of scope**: changing how non-recurring one-shot tasks schedule; per-group defaults beyond the task flags.

## Related work

Closes #2398

## Change kind

- [x] `kind/feature`
- [ ] `kind/bug`
- [ ] `kind/documentation`
- [ ] `kind/cleanup`
- [ ] `kind/hardening`

## Policies

| Policy | Behavior |
|--------|----------|
| `catch-up-latest` | Historical default. Stale occurrence can still run late; re-arm jumps to the next slot ahead of now (periods in between are skipped). |
| `catch-up-all` | Re-arm anchors on the period that just ran so the series walks missed periods oldest-first, capped at the last 24, with a run-log note when the cap applies. |
| `skip-if-missed` | If a run is later than `--grace-window-seconds` (default `600`), it is rolled to the next period **before** the sweep counts due messages, so it never wakes a container for a worthless stale run. |

Existing tasks without a policy parse as `catch-up-latest`.

## CLI surface

```bash
ncl tasks create ... --recurrence-policy catch-up-all
ncl tasks create ... --recurrence-policy skip-if-missed --grace-window-seconds 600
ncl tasks update --id <id> --recurrence-policy catch-up-latest
ncl tasks list
ncl tasks get --id <id>
```

Validation at the edge:

- a recurrence policy requires a recurrence
- `--grace-window-seconds` requires `skip-if-missed`
- list/get report the effective policy (and grace window when relevant)

## Files

- `src/modules/scheduling/missed-runs.ts` + `missed-runs.test.ts` — policy helpers and catch-up / skip logic
- `src/modules/scheduling/task-content.ts` — envelope fields for policy + grace window
- `src/modules/scheduling/recurrence.ts` + tests — clone policy onto the next occurrence
- `src/modules/scheduling/create.ts`, `run-log.ts` — create path + run-log notes for catch-up caps
- `src/host-sweep.ts` — apply skip-if-missed before due counting / wake
- `src/cli/resources/tasks.ts` + tests — `--recurrence-policy`, `--grace-window-seconds`, list/get
- `src/mailbox/types.ts`, `src/mailbox/sqlite/tasks.ts` + tests — content round-trip
- `docs/scheduled-tasks.md` — operator docs

## Validation

- [x] Tests cover the changed behavior (or Validation says why not)

```bash
pnpm exec vitest run \
  src/modules/scheduling/missed-runs.test.ts \
  src/modules/scheduling/recurrence.test.ts \
  src/cli/resources/tasks.test.ts \
  src/mailbox/sqlite/tasks.test.ts
```

Manual:

1. Create a recurring task with each policy; confirm `ncl tasks get` shows it.
2. Freeze time / backdate `process_after` past grace; confirm `skip-if-missed` does not wake.
3. Miss several intervals with `catch-up-all`; confirm oldest-first catch-up and the 24-cap run-log note.
4. Confirm `catch-up-latest` still matches pre-change re-arm behavior.

## User and release impact

- [ ] No user-visible behavior change
- [x] User-visible change — release note below
- [ ] Breaking change — release note below covers detect, why, fix/migration, rollback

```release-note
Recurring tasks can choose how missed runs are handled: catch-up-latest (default), catch-up-all, or skip-if-missed with an optional grace window, via ncl tasks create/update.
```

## Security and trust boundaries

None. Scheduling policy is operator/agent task metadata already gated by existing task CLI / approval paths; no new credential or mount surface.

## Skill delivery

- [x] Not a skill
- [ ] Skill: apply/remove footprint and fresh-clone verification are described above

## AI assistance

- [ ] AI tools or agents helped produce this change
- [x] A human has reviewed this PR and stands behind every change
