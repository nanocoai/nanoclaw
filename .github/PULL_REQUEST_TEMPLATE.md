<!-- nanoclaw-pr-template:v2 -->

<!-- Please give this PR a conventional-commit title (`fix:`, `feat:`, `docs:`,
     `refactor:`, `chore:`, `ci:`, `test:`, `build:`, `style:`, `perf:`) —
     a request, not a requirement; it helps labeling when no kind box is checked.

     Plain English, short sentences, no filler. Write for a reviewer with 60
     seconds — technical terms fine, decoration not. If a sentence adds no
     reviewable fact, delete it.

     Keep Summary, Change kind, Validation, User and release impact,
     Security, and AI assistance in every PR ("None." beats deletion);
     Related work and Skill delivery may go when they don't apply. -->

## Summary

<!-- Shape, by example — one purpose sentence first, then bold-led bullets,
     one fact each:

       Stops the sweep killing slow local-model turns mid-decode.
       - **Problem**: heartbeat only ticks on stream events, so silence = dead.
       - **Fix**: poll tick vouches while the last event is under a cap.
       - **Out of scope**: per-group config; the ceiling PR covers that.

     A reviewer reading only the first sentence should know why this PR
     exists. No prose walls; depth only some reviewers need goes in a
     <details> appendix. -->

## Related work

Closes #
<!-- If there is no issue, say why the change is safe to review directly. -->

## Change kind

<!-- Check exactly one. -->
- [ ] `kind/bug`
- [ ] `kind/feature`
- [ ] `kind/documentation`
- [ ] `kind/cleanup`
- [ ] `kind/hardening`

## Validation

<!-- A bullet per piece of evidence: command -> result. Add the manual path
     for behavior CI cannot cover. New or changed behavior needs a new or
     changed test — or one line saying why not (docs-only, config-only,
     unreachable in CI). -->

- [ ] Tests cover the changed behavior (or Validation says why not)

## User and release impact

<!-- Maintainers own CHANGELOG.md — do not edit it in this PR. -->
- [ ] No user-visible behavior change
- [ ] User-visible change — release note below
- [ ] Breaking change — release note below covers detect, why, fix/migration, rollback

<!-- Release note: written for the person running NanoClaw, not for reviewers.
     **Bold lead: what the operator now sees or can do.** Then at most one
     sentence: the symptom it ends, or the exact command they must run.
     No file names, functions, labels or PR numbers; those go in Summary.
     Example: **Fresh installs no longer leave the setup test agent's
     container running.** It used to log `unable to open database file`
     every few seconds until the next restart. -->

```release-note
Replace this with one user-facing line for the changelog. Required unless "No user-visible behavior change" is checked.
```

## Security and trust boundaries

<!-- Permissions, credentials, untrusted input, workflows, containers, or "None". -->

## Skill delivery

- [ ] Not a skill
- [ ] Skill: apply/remove footprint and fresh-clone verification are described above

## AI assistance

- [ ] AI tools or agents helped produce this change

<!-- Required. -->
- [ ] A human has reviewed this PR and stands behind every change
