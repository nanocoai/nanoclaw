---
name: triage-issues
description: Label new or untriaged GitHub issues — area, kind, needs-repro, and a priority proposal — using TypeSafe judgments gated by confidence. Use when asked to triage issues, label an issue, or process the triage/unresolved queue.
---

# triage-issues

Label an issue the way a maintainer would, with every label decision coming
from `typesafe-judge`. Reads the rubrics in
`/workspace/agent/plugins/maintainer/rubrics/labels.json`; the taxonomy is in
`additional_context/labels.md`.

## Inputs

- One issue number, or "the queue": the open issues carrying
  `triage/unresolved`, newest first, at most 20 per run.
- Skip pull requests (route-pr handles them) and anything with `triage/keep`.

## Steps per issue

1. Build the request and ask all four questions in one call:

   ```bash
   REPO=owner/name   # the repository named for this session; default nanocoai/nanoclaw
   GH=/workspace/agent/plugins/maintainer/scripts/gh.ts
   JUDGE=/app/skills/typesafe-judge/scripts/typesafe-judge.ts
   bun $GH triage-request <n> --repo "$REPO" > /tmp/triage-<n>.json
   bun $JUDGE --input /tmp/triage-<n>.json --gate --compact > /tmp/triage-<n>.out.json
   ```

   `area` and `kind` are choices, `priority` is a score, `needs_repro` is a
   noul. Default gates (act 0.8 / propose 0.6; noul act 0.85 / propose 0.7)
   are already stricter than the 0.6 / 0.7 proposal floors measured on this
   repo.

2. Decide, per answer, from `gate.<id>.decision`:

   | Answer | act | propose | withhold |
   |---|---|---|---|
   | `area` | add the label; remove a different `area/*` only if a human did not set it (check the timeline; when unsure, propose) | proposal line | keep `triage/unresolved` |
   | `kind` | add the label if no `kind/*` present; if a different one is present, propose | proposal line | keep `triage/unresolved` |
   | `priority` | **always a proposal**: `gate.priority.level.index` 0–3 maps to `priority/low`, `medium`, `high`, `critical` | proposal line | omit |
   | `needs_repro` | only when `kind` resolved to bug or security: yes → add `triage/needs-repro`; no → nothing | proposal line | omit |

3. Apply the acts in one call, then write or update the single comment when
   there is at least one proposal:

   ```bash
   bun $GH labels <n> --repo "$REPO" --add area/core,triage/needs-repro
   bun $GH comment <n> --repo "$REPO" --skill triage-issues --body-file /tmp/triage-<n>.md
   ```

   The comment is short: one line per proposal with the label and certainty,
   one line saying a maintainer can apply it by adding the label, nothing
   else. No comment when everything acted or everything withheld.

4. `triage/unresolved`: remove it only when every label-bearing answer
   resolved: `area` and `kind` both acted, and `needs_repro` (when it
   applied) acted or proposed. A withheld `area`, `kind`, or `needs_repro`
   keeps the label (add it if missing). `priority` never counts: it is a
   proposal whichever way it gates.

## Report

Numbered list, one item per issue: number, labels added, proposals with
certainty, withheld questions. Link the issue. Then one line with counts.

## Never

Close, edit, assign, or apply `priority/*`. Never remove a label carrying a
human's decision (`Status: *`, `triage/keep`, `good first issue`).
