---
schedule: '0 9 * * 1'
---

Weekly maintainer digest. Run the `rank-backlog` skill over the 60 most
recently updated open issues, then the `route-pr` skill in report-only mode
over the 20 most recently updated open pull requests (no labels, no comments:
just the gate decisions). Post one message: the backlog digest, then a short
"PRs waiting" list with each PR's readiness gate and suggested reviewer, then
the count of items whose gates withheld. Keep it under 60 lines. Do not apply
any labels during this task; it is a report.
