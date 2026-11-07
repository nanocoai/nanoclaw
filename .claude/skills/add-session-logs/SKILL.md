---
name: add-session-logs
description: Keep a persistent log file per agent session. Writes every stderr line of a session's container to logs/sessions/<session-id>.log, size-bounded, so the output survives the container's --rm exit. Use when an agent hangs, exits having done nothing, or fails and the container log is already gone.
---

# Per-session container logs

Agent containers run with `--rm`. The agent-runner's stderr is gone when the
container exits; the host log keeps it only at debug level, plus a 10-line tail
after a non-zero exit. A session that hangs, or exits 0 without doing anything,
leaves nothing at the default log level.

This skill registers a session log sink (`registerSessionLogSink`, in
`src/drivers/session-log-sink.ts`) that appends every stderr line of a started
session to its own file.

## What this sets up

- `logs/sessions/<session-id>.log`, one file per session. A restarted container
  appends to the same file, after a `--- container <name> started ---` line.
- Each line starts with an ISO-8601 UTC timestamp.
- A per-file size cap (default 5 MiB). At the cap one marker line is written and
  later lines are dropped. Files are never rotated or deleted; remove old ones
  yourself when you no longer need them.

Optional environment variables (read when a session starts):

| Variable                         | Default                   | Meaning               |
| -------------------------------- | ------------------------- | --------------------- |
| `NANOCLAW_SESSION_LOG_DIR`       | `<project>/logs/sessions` | Where the files go    |
| `NANOCLAW_SESSION_LOG_MAX_BYTES` | `5242880`                 | Per-file cap in bytes |

`logs/` is already git-ignored. Session output can contain whatever the agent
prints, including message text; treat these files like the rest of `logs/`.

## Install

Check the seam is present. If this fails, run `/update-nanoclaw` first:

```bash
test -f src/drivers/session-log-sink.ts
```

Copy these files from this skill's `payload/` to the same paths at the project root:

- `payload/src/drivers/session-file-log.ts` -> `src/drivers/session-file-log.ts`
- `payload/src/drivers/session-file-log.test.ts` -> `src/drivers/session-file-log.test.ts`

Append one line to `src/drivers/installed.ts`, unless it is already there:

```ts
import './session-file-log.js';
```

Build and test:

```bash
pnpm run build
pnpm exec vitest run src/drivers/session-file-log.test.ts
```

Restart the service. The next session container started writes its log.

## Integration test

`session-file-log.test.ts` imports the real `installed.ts` barrel and opens a
session through `openSessionLog`, the entry the docker driver calls
(`src/drivers/docker-driver.ts`). Deleting the barrel line, or a module that
no longer evaluates, turns it red. Typecheck guards the `session-log-sink.ts`
API the module consumes. There is no dependency to guard.

## Verify

Start a session, then:

```bash
ls logs/sessions/
tail -n 20 logs/sessions/<session-id>.log
```

## Remove

See [REMOVE.md](REMOVE.md).
