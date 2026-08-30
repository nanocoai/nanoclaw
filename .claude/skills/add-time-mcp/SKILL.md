---
name: add-time-mcp
description: Add Time MCP server for date math, timezone conversions, and natural language date parsing. Prevents agents from hallucinating dates. No credentials needed — pure computation.
---

# Add Time MCP

LLMs are unreliable at date math, day-of-week calculations, and timezone conversions. This skill adds a standalone MCP server that makes "compute, don't guess" the path of least resistance.

Tools added:
- `mcp__time__now` — current date, time, day of week, with timezone conversions
- `mcp__time__resolve` — NL date parsing ("next Thursday 2pm" -> structured ISO + PT/ET)
- `mcp__time__convert` — timezone conversion ("2pm PT" -> ET, UTC)
- `mcp__time__diff` — gap between dates (calendar days, business days, human-readable)
- `mcp__time__range` — list date/time slots in a window ("weekdays next week 9-5")

## Phase 1: Pre-flight

### Check if already applied

Check if `container/agent-runner/src/time-mcp.ts` exists. If it does, skip to Phase 4 (Verify).

## Phase 2: Apply Code Changes

### 2a. Download the MCP server

```bash
curl -fsSL https://raw.githubusercontent.com/taslim/nanoclaw-gws-ea/main/container/agent-runner/src/time-mcp.ts \
  -o container/agent-runner/src/time-mcp.ts
```

### 2b. Add dependencies

```bash
cd container/agent-runner && npm install luxon@^3.5.0 chrono-node@^2.7.7 && npm install -D @types/luxon@^3.4.2 && cd ../..
```

### 2c. Wire the MCP server into the agent runner

Edit `container/agent-runner/src/index.ts`. Make two changes:

**1. Add to allowedTools** — In the `allowedTools` array, add after `'mcp__nanoclaw__*'`:

```typescript
'mcp__time__*',
```

**2. Add to mcpServers** — In the `mcpServers` object, add alongside the existing `nanoclaw` entry. Derive the path from `mcpServerPath` which is already in scope:

```typescript
time: {
  command: 'node',
  args: [path.join(path.dirname(mcpServerPath), 'time-mcp.js')],
},
```

### 2d. Add time tool instructions to CLAUDE.md files

Append the following section to `groups/main/CLAUDE.md` (before the formatting section, if one exists):

```markdown
## Date & Time

Never compute dates, days of the week, or timezone conversions yourself — you will get them wrong. Use `mcp__time__*` tools for every date/time operation:

- **Current time**: Call `mcp__time__now` before referencing "today", the current day/date, or time of day. Never assume you know what day or time it is.
- **Relative dates**: "next Tuesday", "in 3 days", "this Friday" → `resolve` first, then use the result. Never guess.
- **Timezone conversions**: Always `convert`. Never do mental math — "Saturday 3pm PT" to another timezone requires a tool call, not arithmetic.
- **Pre-send check**: Before sending any message containing a specific date, day, or time, verify it via time-mcp. If the tool result contradicts what you were about to say, fix it before sending.
```

Also append the same section to `groups/global/CLAUDE.md` so all non-main groups inherit it. Create the file if it doesn't exist.

### 2e. Copy to per-group agent-runner

Existing groups have a cached copy of the agent-runner source. Copy the new files:

```bash
for dir in data/sessions/*/agent-runner-src; do
  cp container/agent-runner/src/time-mcp.ts "$dir/"
  cp container/agent-runner/src/index.ts "$dir/"
done
```

### 2f. Validate code changes

```bash
cd container/agent-runner && npx tsc --noEmit && cd ../..
npm run build
./container/build.sh
```

All three must be clean before proceeding. The first validates agent-runner TypeScript (which is only compiled at container startup — catching errors here saves a round trip).

## Phase 3: Configure

### Default timezone

The server reads the `TZ` environment variable, which the container runner already passes from the host. No configuration needed.

### Default conversion zones

Edit `DEFAULT_CONVERT_ZONES` in `container/agent-runner/src/time-mcp.ts`. Default: `['America/Los_Angeles', 'America/New_York', 'UTC']`.

### Restart the service

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Verify

### Test via messaging

Tell the user:

> Send a message like: "what day of the week is April 15?"
>
> The agent should use `mcp__time__resolve` to compute the answer instead of guessing.

Other test prompts:
- "What time is it?" — should use `mcp__time__now`
- "Convert 2pm PT to ET" — should use `mcp__time__convert`
- "How many business days until May 1?" — should use `mcp__time__diff`
- "List the weekdays next week" — should use `mcp__time__range`

### Check logs if needed

```bash
tail -50 groups/*/logs/container-*.log
```

Look for `mcp__time__` tool calls in the agent output.

## Troubleshooting

### Agent computes dates instead of using tools

Verify the "Date and Time" section is present in `groups/main/CLAUDE.md` and `groups/global/CLAUDE.md` (see step 2d). If the instructions are there and the agent still guesses, try being explicit: "use mcp__time__resolve to tell me what day March 15 is."

### Agent says time tools are not available

1. The MCP server wasn't registered — check `container/agent-runner/src/index.ts` has `'mcp__time__*'` in `allowedTools` and `time` in `mcpServers`
2. The per-group source wasn't updated — re-copy files (see step 2e)
3. The container wasn't rebuilt — run `./container/build.sh`

### Wrong timezone

The server uses `TZ` from the container, which the host passes automatically via `container-runner.ts`. If it's wrong, check `TZ` in your shell environment or `.env` file.
