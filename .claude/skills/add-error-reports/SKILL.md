---
name: add-error-reports
description: Report this NanoClaw install's own operational failures — startup crash-loop backoff, failing or auto-paused scheduled-task scripts, permanently failed deliveries — to a chat you choose, through the normal channel delivery path. Rate-limited per failure. Use when the user wants to be told when NanoClaw itself breaks instead of finding out from silence.
---

# Add Error Reports

Nothing watches NanoClaw itself. A host crash-looping on startup, or a
scheduled task whose pre-task script keeps failing and backing off, only
writes to the host log — from the chat side it looks exactly like "nothing to
report". This skill forwards those failures to one chat.

It registers a sink on core's operational error seam
(`registerOperationalErrorSink` in `src/operational-errors.ts`) and delivers
through the channel adapter core already uses, so any installed channel works
as the destination.

| Report                 | When core raises it                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `host.startup-backoff` | The host restarted repeatedly without a clean shutdown and startup is being delayed  |
| `task.script-failing`  | A recurring task's pre-task script failed its last run(s); the series is backing off |
| `task.auto-paused`     | The script failed so many times in a row that the series was paused                  |
| `delivery.failed`      | An outbound message was given up on after its final delivery attempt                 |

Each report is one short message: a summary line, the kind and time, and the
details core attached (series id, attempt counts, the delivery error).
Repeats of the same failure inside the quiet window (default 60 minutes) are
counted instead of sent; the next report for it says how many were suppressed.

## Pre-flight

The seam must exist in this checkout:

```bash
test -f src/operational-errors.ts && grep -q registerOperationalErrorSink src/operational-errors.ts && echo ok
```

If that prints nothing, update NanoClaw first (`/update-nanoclaw`); this skill
has nothing to attach to without it.

## Apply

### 1. Copy the module and its test

```bash
mkdir -p src/modules/error-reports
cp .claude/skills/add-error-reports/src/modules/error-reports/*.ts src/modules/error-reports/
```

This copies `index.ts` (registration), `reporter.ts` (format, rate limit,
queue, delivery), and `error-reports.test.ts`.

### 2. Register the module

Append the import to the modules barrel, once:

```bash
grep -qxF "import './error-reports/index.js';" src/modules/index.ts \
  || echo "import './error-reports/index.js';" >> src/modules/index.ts
```

### 3. Choose the destination

Reports go to one existing messaging group. List them and pick the chat that
should receive reports — a dedicated operations chat keeps them apart from
agent conversations:

```bash
ncl messaging-groups list
```

The chat must be one the bot can post in. It does not need an agent wired to
it. Add the chosen id to `.env`:

```
ERROR_REPORTS_MESSAGING_GROUP=<messaging-group-id>
```

Optional settings, also in `.env`:

| Variable                      | Default | Meaning                                                |
| ----------------------------- | ------- | ------------------------------------------------------ |
| `ERROR_REPORTS_THREAD_ID`     | unset   | Post into this thread of the chat instead of top level |
| `ERROR_REPORTS_QUIET_MINUTES` | `60`    | Minimum gap between two reports of the same failure    |

With `ERROR_REPORTS_MESSAGING_GROUP` unset the module registers nothing.

### 4. Build, test, restart

```bash
pnpm run build
pnpm exec vitest run src/modules/error-reports
bash setup/lib/restart.sh
```

The test imports the real modules barrel, raises errors through core's
`reportOperationalError`, resolves the destination from a real central DB,
and asserts the message reaches the delivery adapter. Deleting the barrel line
or drifting from the seam or the delivery adapter turns it red.

## Troubleshooting

- **No report arrives.** Check `logs/nanoclaw.log` for `Error reports:` lines.
  `messaging group not found` means the id in `.env` is wrong — re-check it
  with `ncl messaging-groups list`. `delivery failed` means the channel
  rejected the post; make sure the bot is a member of that chat.
- **A crash loop was never reported.** Reports travel through a channel, so a
  host that crashes before its channels start cannot send one. The backoff
  report is queued and sent as soon as a start gets far enough to bring the
  channels up; a host that never gets that far only logs it to
  `logs/nanoclaw.error.log`.
- **Too many reports.** Raise `ERROR_REPORTS_QUIET_MINUTES`, then restart.
