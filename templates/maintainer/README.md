# maintainer

A repository maintainer's assistant. Every classification, routing, ranking,
and yes/no judgment comes from TypeSafe's Jev model through the
`typesafe-judge` container tool; the agent gathers evidence, reasons, and
writes. It labels and comments; it never merges, closes, assigns, or edits.

Long-term home: [`nanocoai/nanoclaw-templates`](https://github.com/nanocoai/nanoclaw-templates).
It sits in this repo's `templates/` for review of the experiment.

## What it does

| Skill | Judgments (TypeSafe) | Code | Writes |
|---|---|---|---|
| `triage-issues` | area (choice), kind (choice), priority (score), needs-repro (noul) | rubric loading, label application | `area/*`, `kind/*`, `triage/*` labels; one proposal comment |
| `route-pr` | area, kind, priority, pr_ready (noul), scope matches title (noul) | PR template section status, CODEOWNERS / recent-author reviewer | `Status: Needs Review` or `triage/needs-author`, area; one comment with the suggested reviewer |
| `dedupe-issues` | "same defect as #X" (noul) per candidate, 30 in one call | title-similarity candidate ranking over open issues | one comment listing matches with probabilities |
| `rank-backlog` | priority (score), needs-repro (noul) per issue | staleness, composite ranking, digest text | posts the digest; no labels |

Gate policy (from `typesafe-judge --gate`): **act** applies a reversible
label, **propose** writes a line in the skill's single marker comment,
**withhold** leaves `triage/unresolved` for a human. `priority/*` is always a
proposal. Thresholds in the skills came from measured runs on
nanocoai/nanoclaw (area/kind 0.6, priority 0.6, noul 0.7 as proposal floors;
act sits above them).

The recurring task `weekly-digest` (Mondays 09:00, created paused) posts the
backlog digest and the PR queue in report-only mode.

## Requirements

1. `/add-typesafe-tool` applied on the install (mounts `typesafe-judge` and
   registers the `api.typesafe.ai` credential in the gateway).
2. A GitHub credential for `api.github.com` connected in the gateway with
   `repo` scope (the OneCLI GitHub app, or a fine-grained PAT stored as a
   generic secret for host `api.github.com`, header `Authorization`, format
   `Bearer {value}`). The agent reads issues, PRs, files and commits, and
   writes labels and comments; nothing else.
3. Bun in the agent image (the default image has it).

## Stamp it

```bash
ncl groups create --template maintainer --name "Maintainer"
ncl tasks list --status paused          # weekly-digest, resume when ready
```

Then wire a channel with `/manage-channels`. First message to try:

> Triage issue 3839.

## Layout

```
maintainer/
├── plugin.json
├── README.md
├── rubrics/labels.json                       # area/kind/priority rubrics + the two noul questions
├── scripts/gh.ts                             # GitHub fetch, state shaping, candidates, digest, label/comment writes
├── scripts/gh.test.ts                        # bun test (mocked fetch)
├── skills/{triage-issues,route-pr,dedupe-issues,rank-backlog}/SKILL.md
└── ai.nanoco.nanoclaw/
    ├── context/instructions.md               # persona and the act/propose/withhold policy
    ├── context/additional_context/labels.md  # label taxonomy
    └── tasks/weekly-digest.md                # paused recurring task
```

Test the helper: `cd scripts && bun test`.
