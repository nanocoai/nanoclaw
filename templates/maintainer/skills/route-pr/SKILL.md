---
name: route-pr
description: Route a GitHub pull request — ready for review or needs-author, its area label, and a suggested reviewer from CODEOWNERS or recent authors — using TypeSafe judgments gated by confidence. Use when asked to check, route, or label a PR, or to process the review queue.
---

# route-pr

Decide whether a pull request is ready for a maintainer, label its area, and
suggest who should look at it. Readiness and area are `typesafe-judge`
answers; the reviewer comes from CODEOWNERS (deterministic), falling back to
the recent authors of the touched files. You never request a review or
assign; you suggest in the comment.

## Inputs

- One PR number, or "the queue": open, non-draft PRs without `Status: *`
  labels, newest first, at most 20 per run. Drafts are skipped unless named.
- A "report-only" run (the weekly digest) computes everything and writes
  nothing.

## Steps per PR

1. Build the request (state includes `draft`, `changed_files`, the PR
   template's section status, and `reviewer_candidates`) and ask in one call:

   ```bash
   REPO=owner/name   # the repository named for this session; default nanocoai/nanoclaw
   GH=/workspace/agent/plugins/maintainer/scripts/gh.ts
   JUDGE=/app/skills/typesafe-judge/scripts/typesafe-judge.ts
   bun $GH route-request <n> --repo "$REPO" > /tmp/route-<n>.json
   bun $JUDGE --input /tmp/route-<n>.json --gate --compact > /tmp/route-<n>.out.json
   ```

   Questions: `area` (choice), `kind` (choice), `priority` (score, proposal
   only), `pr_ready` (noul: template filled, validation stated, diff matches
   title), `scope_matches_title` (noul).

2. Decide:

   | Answer | act | propose | withhold |
   |---|---|---|---|
   | `pr_ready` yes | add `Status: Needs Review` | proposal line | nothing |
   | `pr_ready` no | add `triage/needs-author` and list, in the comment, the template sections that are `empty` or `missing` in `state.template.sections` (`omitted` ones are optional and are not listed) | proposal line with the same list | nothing |
   | `scope_matches_title` no (act or propose) | one comment line naming the files that look out of scope; never a label | same | nothing |
   | `state.changed_files_truncated` is true | the judge saw only the first 300 paths: treat `pr_ready` and `scope_matches_title` as `propose` at most, and say in the comment that the PR is too large to route automatically | same | same |
   | `area` | add the label if no `area/*` present (the labeler may have added one from paths; if it differs, propose) | proposal line | nothing |
   | `kind` | add if no `kind/*` present; the PR template checkbox usually already set it | proposal line | nothing |

   Reviewer: take the first entry of `state.reviewer_candidates`
   (CODEOWNERS wins over recent authors). Write "Suggested reviewer: @login
   (reason, files)" in the comment. If the list is empty, say so.

3. Apply labels, then write or update the one comment:

   ```bash
   bun $GH labels <n> --repo "$REPO" --add "Status: Needs Review",area/skills
   bun $GH comment <n> --repo "$REPO" --skill route-pr --body-file /tmp/route-<n>.md
   ```

   The comment has at most: the readiness line with certainty, the missing
   sections (if any), the scope note (if any), the reviewer suggestion, and
   one line of proposals. Under 12 lines.

## Report

Numbered list per PR: number, ready/needs-author with certainty, area,
suggested reviewer, proposals. Link each PR.

## Never

Merge, close, approve, request changes, request a reviewer, or change a
`Status: *` label a human set. Never edit the PR body, even to fill the
template.
