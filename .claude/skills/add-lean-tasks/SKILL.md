---
name: add-lean-tasks
description: Add lean scheduled-task runs for small or local models. A task marked `--lean true` runs with a slim plain system prompt and no skills, memory, tools, MCP servers or session resume, and delivers through `<message>` and `<card>` blocks in its final text; an optional `--render` command reformats that text first. Use when a scheduled task should run cheaply on a small model, or when the user asks for "lean tasks", "minimal-context tasks" or "render command for tasks".
---

# Lean task runs

A normal scheduled task runs with the agent's full context: the Claude Code
system prompt, the composed instructions, skills, memory, every MCP server and
the previous session. A small or local model spends most of its time reading
that context, and often cannot drive the tools anyway.

This skill adds two task flags:

- `--lean true` runs each fire of the task with minimal context: a short plain
  system prompt (the agent name, the destinations and the output format), no
  filesystem settings (no skills, instruction files or memory hook), no
  session resume, no MCP servers and no built-in tools. The model sees the task
  prompt, plus any pre-task script data, and nothing else.
- `--render "<command>"` (lean tasks only) pipes the model's final text into
  the command on stdin; the command's stdout is delivered instead. The model
  can then answer with plain data (for example a small JSON verdict) and a
  script turns it into the message.

A lean turn has no `send_message` tool, so it delivers through blocks in its
final text:

- `<message to="NAME">text</message>` sends a chat message to destination NAME.
- `<card to="NAME" title="Short title">text</card>` posts a display card to a
  channel destination NAME.

Everything outside those blocks is the run log, as for any task. Each block is
recorded in the log as one line, for example `[sent → family] All good`.

Lean runs apply to groups on the Claude provider, including non-Claude models
served through an Anthropic-compatible endpoint. On other providers the flag is
stored but the task runs normally.

## Prerequisites

The skill builds on four core seams. Check that each is present before copying
anything:

```bash
grep -q "export function registerTaskField" src/modules/scheduling/task-fields.ts \
  && grep -q "export function registerTurnHook" container/agent-runner/src/turn-hooks.ts \
  && grep -q "export function registerProviderWrapper" container/agent-runner/src/providers/provider-registry.ts \
  && grep -q "minimalContext" container/agent-runner/src/providers/types.ts \
  && grep -q "systemPromptMode" container/agent-runner/src/providers/types.ts \
  && echo ready
```

If this does not print `ready`, stop and update NanoClaw first (`/update-nanoclaw`);
the skill needs the task-field registry, the turn-hook registry, the provider
wrapper registry, and the `minimalContext` and `systemPromptMode` provider
options.

## Install

### 1. Copy the payload

Copy these files from this skill's `payload/` directory to the same paths at the
project root, overwriting any earlier copy:

```
payload/src/modules/lean-tasks/index.ts
  -> src/modules/lean-tasks/index.ts
payload/src/modules/lean-tasks/lean-tasks.test.ts
  -> src/modules/lean-tasks/lean-tasks.test.ts
payload/container/agent-runner/src/modules/lean-tasks/index.ts
  -> container/agent-runner/src/modules/lean-tasks/index.ts
payload/container/agent-runner/src/modules/lean-tasks/doors.ts
  -> container/agent-runner/src/modules/lean-tasks/doors.ts
payload/container/agent-runner/src/modules/lean-tasks/lean-tasks.test.ts
  -> container/agent-runner/src/modules/lean-tasks/lean-tasks.test.ts
```

```bash
mkdir -p src/modules/lean-tasks container/agent-runner/src/modules/lean-tasks
cp "${CLAUDE_SKILL_DIR}"/payload/src/modules/lean-tasks/*.ts src/modules/lean-tasks/
cp "${CLAUDE_SKILL_DIR}"/payload/container/agent-runner/src/modules/lean-tasks/*.ts container/agent-runner/src/modules/lean-tasks/
```

### 2. Register both halves

Append this line to the end of `src/modules/index.ts` (the host modules barrel),
unless it is already there. It registers the `--lean` and `--render` task fields:

```typescript
import './lean-tasks/index.js';
```

Append the same line to the end of `container/agent-runner/src/modules/index.ts`
(the agent-runner modules barrel), unless it is already there. It registers the
turn hook that detects lean task batches and the Claude provider wrapper that
runs them:

```typescript
import './lean-tasks/index.js';
```

Keep every existing import in both files.

### 3. Build and test

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
pnpm exec vitest run src/modules/lean-tasks
cd container/agent-runner && bun test src/modules/lean-tasks
```

The host test drives `ncl tasks create/update/get` through the real modules
barrel and checks the envelope fields. The agent-runner test drives the real
modules, providers and contracts barrels: it prepares a lean task turn through
the turn-hook runner, runs it through `createProvider('claude')` against a
stubbed SDK, and checks the minimal query options, the door deliveries and the
render step. Both go red if either barrel line is removed.

### 4. Restart

Restart the host with the installation's normal service workflow so `ncl`
knows the new flags. The agent-runner source is mounted into every container,
so the next container spawn runs the new code.

## Use

Mark an existing task lean:

```bash
ncl tasks update --id <series-id> --lean true
```

Or create one:

```bash
ncl tasks create --group <group-id> --name daily-check \
  --recurrence "0 9 * * *" --lean true \
  --prompt 'Read the data below. If anything failed, send one line to family.'
```

Write lean prompts for the model that runs them: say which destination to use
and when to stay silent. Heavy data gathering belongs in a pre-task `--script`,
whose output reaches the prompt; the lean turn itself cannot run tools.

Add a render command when the model should return data and a script should
write the message:

```bash
ncl tasks update --id <series-id> \
  --render 'bun /workspace/agent/scripts/render-check.ts'
```

The command runs inside the agent container with `bash -c`, reads the model text
on stdin and prints the text to deliver, including its `<message>` or `<card>`
blocks. It has 30 seconds. If it fails or prints nothing, the model text is used
unchanged. With a render command set, the lean system prompt asks the model only
for the output the task describes and does not teach the blocks.

Turn it back off with `--lean false`; clear a render command with
`--render none`. `ncl tasks get` shows both fields.

A lean turn always sends a plain system prompt, so it also suits a non-Claude
model behind an Anthropic-compatible endpoint, whatever the group's
`--system-prompt-mode` is.

## Troubleshooting

- **The task still runs with the full context.** Check that `ncl tasks get --id
  <series-id>` shows `lean: true`, that the group's provider is `claude`, and
  that `container/agent-runner/src/modules/index.ts` imports
  `./lean-tasks/index.js`. Container logs show `[lean-tasks] Lean task batch`
  when a fire is detected.
- **`unknown flag --lean`.** The host barrel line is missing or the host was not
  restarted after install.
- **Nothing is delivered.** Read the task's run log (`groups/<folder>/tasks/<series-id>.md`):
  each block is recorded as `sent` or `not delivered`. A block is not delivered
  when its `to` names no destination (cards need a channel destination) or its
  body is empty. Plain text without blocks is only logged, by design.
- **The render output is ignored.** The container log shows `render failed`,
  `render timed out` or `render printed nothing`; run the command by hand with
  sample input.
