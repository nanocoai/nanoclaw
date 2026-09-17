---
name: rank-backlog
description: Rank the open issue backlog into a digest — TypeSafe priority and evidence judgments per issue, staleness computed in code, combined into one ranked list. Use when asked what to work on next, for a backlog review, or for the weekly digest.
---

# rank-backlog

Two judgments per issue from `typesafe-judge` (a `priority` score and a
`needs_repro` noul), staleness from `updated_at`, and a fixed composite
formula in code. The digest is written by the helper; you add at most three
sentences of context on top.

## Inputs

- Scope: the N most recently updated open issues (default 60, max 200), or
  a label filter the maintainer names.

## Steps

1. Emit one request per issue and judge them one at a time (the state
   differs per issue, so they cannot share a call):

   ```bash
   REPO=owner/name   # the repository named for this session; default nanocoai/nanoclaw
   GH=/workspace/agent/plugins/maintainer/scripts/gh.ts
   JUDGE=/app/skills/typesafe-judge/scripts/typesafe-judge.ts
   bun $GH backlog-requests --repo "$REPO" --limit 60 > /tmp/backlog.ndjson
   : > /tmp/backlog.results.ndjson
   failed=0
   while IFS= read -r line; do
     printf '%s' "$line" > /tmp/backlog.one.json
     if out=$(bun $JUDGE --input /tmp/backlog.one.json --gate --compact); then
       printf '%s\n' "$(printf '%s' "$line" | bun -e 'const s=JSON.parse(await Bun.stdin.text()).state;const r=JSON.parse(process.argv[1]);console.log(JSON.stringify({state:s,answers:r.answers,gate:r.gate}))' "$out")" >> /tmp/backlog.results.ndjson
     else
       rc=$?
       [ "$rc" -eq 2 ] && { echo "TypeSafe credential not connected; stopping" >&2; exit 2; }
       failed=$((failed + 1))
     fi
   done < /tmp/backlog.ndjson
   echo "judge failures: $failed"
   ```

   `--gate` travels with each result: the digest ranks an issue whose
   priority gate is `withhold` as unknown, never as low or high. A judge call
   that fails for one item (exit 3) skips that issue and is counted; exit
   code 2 (credential not connected) stops the run at once.

2. Compose the digest:

   ```bash
   bun $GH digest /tmp/backlog.results.ndjson > /tmp/backlog.md
   ```

   Ranking: `0.7 · priority/3 · confidence + 0.2 · min(1, quiet_days/180)
   − 0.1 · P(needs repro)`, with a withheld priority ranked as unknown. Two
   lists: "Act on next" (top 10) and "Quiet and low priority" (90+ days
   quiet, a *known* priority below high), plus the untriaged and
   priority-withheld counts.

3. Post the digest as-is, then at most three sentences: what stands out, and
   any issue whose ranking you think the maintainer should double-check
   (say why in terms of the numbers). Priority labels are never applied by
   this skill; the digest is a proposal.

## Report

The digest itself. If judge calls failed, one line: how many, and the first
error text.

## Never

Close stale issues, apply `priority/*`, or add `stale`. The "quiet" list is
for the maintainer to act on.
