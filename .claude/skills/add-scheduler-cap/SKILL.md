---
name: add-scheduler-cap
description: Cap how many agent containers the scheduler sweep keeps running. Set SCHEDULER_MAX_CONTAINERS in .env; due sessions beyond the cap wait for the next sweep, and idle containers make room for them.
---

# Add scheduler container cap

Limits concurrent containers on installs where many scheduled tasks come due together. Without a limit set, behavior is unchanged.

## How it behaves

- The reconcile sweep asks the scheduler admission seam (`src/modules/scheduling/admission.ts`) before waking a session that has due messages. This skill registers an admission that admits the wake while `running containers + wakes already admitted but not yet running` is below `SCHEDULER_MAX_CONTAINERS`.
- A deferred session is retried by the next sweep because its due rows remain.
- When the cap is full and a session is deferred, a running container that has gone idle (no due messages, nothing in flight) is stopped through the seam's `onSessionIdle`, so the deferred session can start. A container below the cap is never stopped.
- The cap counts every running container. It gates only sweep-driven wakes; a message that arrives from a chat still wakes its session directly.

## Steps

### 1. Copy the module and its tests

```
.claude/skills/add-scheduler-cap/payload/src/modules/scheduler-cap/cap.ts          → src/modules/scheduler-cap/cap.ts
.claude/skills/add-scheduler-cap/payload/src/modules/scheduler-cap/cap.test.ts     → src/modules/scheduler-cap/cap.test.ts
.claude/skills/add-scheduler-cap/payload/src/modules/scheduler-cap/index.ts        → src/modules/scheduler-cap/index.ts
.claude/skills/add-scheduler-cap/payload/src/modules/scheduler-cap/wiring.test.ts  → src/modules/scheduler-cap/wiring.test.ts
```

### 2. Register the module

Append this line to `src/modules/index.ts` if it is not already there:

```typescript
import './scheduler-cap/index.js';
```

### 3. Set the limit

Add to `.env` (a positive integer; anything else leaves the cap off and logs a warning):

```
SCHEDULER_MAX_CONTAINERS=3
```

### 4. Build, test, restart

```bash
pnpm run build
pnpm exec vitest run src/modules/scheduler-cap
```

Then restart the host with the installation's normal service workflow. The host logs `Scheduler container cap enabled` at startup.

## Troubleshooting

- **Cap not applied**: check the startup log for `Scheduler container cap enabled`; a `must be a positive integer` warning means the value was rejected.
- **A due task never runs**: every running container must be busy for it to wait; raise the limit or check for stuck sessions with `ncl sessions list`.
