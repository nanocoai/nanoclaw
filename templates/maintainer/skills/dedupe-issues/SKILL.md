---
name: dedupe-issues
description: Find likely duplicates of a GitHub issue by asking TypeSafe, for each of the 30 most similar open issues by title, whether it reports the same defect. Use when asked whether an issue is a duplicate, to dedupe a new issue, or to sweep recent issues for duplicates.
---

# dedupe-issues

Candidates are found in code (title similarity over the open issues); the
judgment "same defect as issue X" is a `noul` per candidate, all asked in one
fan-out. You never close a duplicate; you leave one comment linking the
matches with their probabilities.

## Inputs

- One issue number, or "recent": the open issues created in the last 7 days,
  at most 20 per run.

## Steps per issue

1. Build the request: the 30 most similar open issues by title (token
   overlap, body as a tie-breaker) over the 300 most recently updated, with
   one noul question per candidate:

   ```bash
   REPO=owner/name   # the repository named for this session; default nanocoai/nanoclaw
   GH=/workspace/agent/plugins/maintainer/scripts/gh.ts
   JUDGE=/app/skills/typesafe-judge/scripts/typesafe-judge.ts
   bun $GH similar-request <n> --repo "$REPO" --top 30 > /tmp/dedupe-<n>.json
   bun $JUDGE --input /tmp/dedupe-<n>.json --gate --compact --noul-act 0.9 --noul-propose 0.7 > /tmp/dedupe-<n>.out.json
   ```

   The act threshold is raised to 0.9 because a wrong duplicate call sends a
   reporter away. Each answer is `same_as_<number>`.

2. Decide from `gate.same_as_<number>`:

   | Gate | value | You |
   |---|---|---|
   | act | true | "Likely duplicate of #X (p=0.93)" |
   | propose | true | "Possibly the same as #X (p=0.78)" |
   | act or propose | false | nothing |
   | withhold | any | nothing |

   Order matches by probability, highest first, at most five.

3. When there is at least one match, write or update the single comment:

   ```bash
   bun $GH comment <n> --repo "$REPO" --skill dedupe-issues --body-file /tmp/dedupe-<n>.md
   ```

   Content: the match lines, then one sentence: a maintainer decides whether
   to close one as a duplicate; nothing is closed automatically. No comment
   when nothing matched.

4. Add no labels. (The repo has no duplicate label; if the maintainer adds
   one, apply it only on an `act`.)

## Report

Per issue: number, matches with probabilities, or "no duplicates found".
Then the count of issues checked.

## Never

Close, mark as duplicate, or edit either issue. Never compare against closed
issues unless the maintainer asks; a fixed defect that reappears is a new bug.
