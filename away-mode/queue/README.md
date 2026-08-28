# Away Mode Per-Item Run Logs

`<queue-item-id>/run.md` — one append-only, timestamped-line markdown file per queue item, created on demand. Reuses `src/modules/scheduling/run-log.ts`'s exact shape (`appendRunLog`-style: `<timestamp> — <message>`) for raw command output, build/test results, and step-by-step progress. This is where the noisy detail goes — the journal (`away-mode/journal/`) stays curated and readable; this is the working transcript.

Gitignored except this README — per-installation runtime state, same as `groups/`.
