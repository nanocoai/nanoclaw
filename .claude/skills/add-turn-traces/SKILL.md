---
name: add-turn-traces
description: Record a trace of every agent turn — inbound content, tool calls with inputs and outputs, mid-turn text, final output, timings, provider and model — in the central DB with short retention, and read them with `ncl traces list/get`. Opt-in per agent group. Use when the operator wants to see what an agent actually did on a turn without an external tracing backend.
---

# /add-turn-traces — per-turn traces in the central DB

Each time an agent in an opted-in group answers a batch of messages, the container sends one trace to the host, which stores it in a `turn_traces` table. The operator reads traces with `ncl traces list` and `ncl traces get <id>`. Nothing leaves the machine.

```
agent container                               host
┌─────────────────────────┐  turn_trace      ┌──────────────────────────┐
│ turn hooks → recorder   │  system action   │ delivery action → table  │
│ Claude tool hooks ──────┤ ───────────────→ │ retention prune          │
└─────────────────────────┘  (outbound.db)   │ ncl traces list / get    │
                                             └──────────────────────────┘
```

A trace holds:

- **Turn**: the batch's message ids, provider, configured model, status (`ok`, `error`, `incomplete`), start/end time and duration.
- **Content**: the inbound message content and the final result text (each capped at 8000 characters), and the provider error when the turn failed.
- **Steps**: mid-turn text and tool calls in order. Each tool call carries its name, input, output (each capped at 2000 characters), error flag and duration. At most 200 steps per turn; the rest are counted, not kept.

Tool calls are recorded for the Claude provider, which exposes SDK tool hooks. Other providers get turn-level traces (content, text, result, timings) without tool steps.

## Privacy

Traces contain prompt content, tool inputs and tool outputs, which may include personal data or anything an agent read.

- **Opt-in twice**: installing the skill records nothing by itself. A group is traced only while its folder holds a `turn-traces.enabled` file (step 7).
- **Short retention**: traces are kept for 3 days by default (`TURN_TRACE_RETENTION_DAYS`).
- **Operator only**: `ncl traces` refuses every container caller, whatever its `cli_scope`.
- **Not an audit log**: the marker file sits in the agent's own workspace, so an agent can remove it. Use traces for debugging, not as a control.

REMOVE.md drops the table with the skill.

## Prerequisites

The container side attaches through the poll loop's turn-lifecycle hooks. Check they exist:

```bash
grep -q "export function registerTurnHook" container/agent-runner/src/turn-hooks.ts && echo ok
```

If this does not print `ok`, stop: this install predates the turn-hook registry and the skill cannot attach.

## Apply

Every step is safe to re-run: copies overwrite, appends are skipped when the line is already there, and the provider edit is skipped when already made.

### 1. Copy the host module and its test

```bash
mkdir -p src/modules/turn-traces
cp .claude/skills/add-turn-traces/files/host/*.ts src/modules/turn-traces/
```

This adds `index.ts` (registrations), `migration.ts`, `db.ts`, `apply.ts` (the `turn_trace` delivery action), `retention.ts`, `resource.ts` (`ncl traces`) and `turn-traces.test.ts`.

### 2. Register the host module

Append this line at the end of `src/modules/index.ts`, unless it is already there:

```typescript
import './turn-traces/index.js';
```

```bash
grep -qxF "import './turn-traces/index.js';" src/modules/index.ts || echo "import './turn-traces/index.js';" >> src/modules/index.ts
```

The module registers its table migration (`module:turn-traces:create-table`), the `turn_trace` delivery action and the `traces` CLI resource.

### 3. Copy the container module and its tests

```bash
mkdir -p container/agent-runner/src/modules/turn-traces
cp .claude/skills/add-turn-traces/files/container/*.ts container/agent-runner/src/modules/turn-traces/
```

This adds `recorder.ts`, `index.ts` (turn-hook registration), `claude-hooks.ts`, `turn-traces.test.ts` and `claude-hooks.test.ts`.

### 4. Register the container module

Append this line at the end of `container/agent-runner/src/modules/index.ts`, unless it is already there:

```typescript
import './turn-traces/index.js';
```

```bash
grep -qxF "import './turn-traces/index.js';" container/agent-runner/src/modules/index.ts || echo "import './turn-traces/index.js';" >> container/agent-runner/src/modules/index.ts
```

### 5. Hand the trace hooks to the Claude provider

This is the skill's one code edit. In `container/agent-runner/src/providers/claude.ts`, skip this step if `withTurnTraceHooks` already appears in the file. Otherwise:

1. Add this import next to the other relative imports:

   ```typescript
   import { withTurnTraceHooks } from '../modules/turn-traces/claude-hooks.js';
   ```

2. In `query()`, wrap the object passed as `hooks` to `sdkQuery` in `withTurnTraceHooks(...)`. Keep every existing entry as it is:

   ```typescript
   hooks: withTurnTraceHooks({
     PreToolUse: [{ hooks: [preToolUseHook] }],
     // ...the existing entries, unchanged
   }),
   ```

`withTurnTraceHooks` appends trace matchers after the provider's own, so the existing PreToolUse guard still runs first and can still block a call.

### 6. Set retention (optional)

Traces older than 3 days are pruned. The first trace a host process records prunes and starts an hourly prune, and every `ncl traces` read prunes first, so an expired trace is never shown. To change the window, add to `.env` (fractional days are allowed):

```
TURN_TRACE_RETENTION_DAYS=1
```

### 7. Opt a group in

Ask the operator which agent groups to trace. For each, create the marker in the group's folder:

```bash
touch groups/<folder>/turn-traces.enabled
```

The container checks the marker at the start of every turn, so this takes effect on the group's next turn. Delete the file to stop tracing the group.

### 8. Build and test

```bash
pnpm run build
pnpm exec vitest run src/modules/turn-traces/turn-traces.test.ts
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
(cd container/agent-runner && bun test src/modules/turn-traces/)
```

The tests are the verification:

- `src/modules/turn-traces/turn-traces.test.ts` loads the real modules barrel and runs the real migrations, then drives the registered `turn_trace` action and `ncl traces list/get` through the CLI dispatcher. It covers the host-only refusal and retention pruning. Deleting the step 2 line turns it red.
- `container/agent-runner/src/modules/turn-traces/turn-traces.test.ts` drives the turn-hook dispatch the poll loop calls and reads the resulting outbound row, with and without the opt-in marker. Deleting the step 4 line turns it red.
- `container/agent-runner/src/modules/turn-traces/claude-hooks.test.ts` runs the real Claude provider against a fake SDK that fires the configured tool hooks. Removing the step 5 wrap turns it red.

### 9. Restart

Restart the service so the host loads the module:

```bash
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)                 # Linux
# or: launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
```

Running containers keep their old code until they respawn. `ncl groups restart --id <group-id>` respawns one group now.

## Usage

```bash
ncl traces list                                   # newest 20 turns, one-line output preview
ncl traces list --agent-group-id <id> --status error --limit 50
ncl traces list --session-id <id>
ncl traces get <trace-id>                         # full trace with every step
ncl traces get <trace-id> --json                  # raw JSON
```

`status` is `ok` when the provider returned a result, `error` when the result was an error or the query threw, and `incomplete` when the query ended before the turn got a result.

## Troubleshooting

- **`ncl traces` is unknown**: the host module is not loaded. Check the step 2 line and restart the host.
- **No rows after a turn**: check the group folder has `turn-traces.enabled`. If it does, the container that ran the turn started before the skill was applied; respawn the group (`ncl groups restart --id <group-id>`). Then check `logs/nanoclaw.log` for `turn_trace dropped` warnings.
- **Traces have no tool steps**: the group runs a provider other than Claude, or the step 5 edit is missing (`bun test src/modules/turn-traces/claude-hooks.test.ts` fails).
- **A container agent cannot read traces**: expected. `ncl traces` is host-only.
