---
name: add-tool-visibility
description: Add live chat-side visibility for agent tool calls — shows "🖥️ bash: <cmd>" before each tool call, failure markers, and duration markers after slow Bash. Surfaces what the agent is doing in real time during long multi-step runs. Triggers on "tool visibility", "live tool use", "show tool calls", "tool preview".
---

# Add Tool Visibility

Adds live tool-call previews to chat. When the agent runs Bash, Read, Write,
Edit, WebFetch, or sub-agent (Task/Agent) tools, a short message describing
the call is written to the session's outbound DB and delivered into the same
chat thread the user is conversing in. Slow Bash calls (> 3s) get a completion
marker; failed calls get a ❌ marker with the reason; long-running Agent/Task
calls get a "still working — Xs elapsed" tick every 30s. Scheduled-task
sessions are suppressed entirely (no orphan previews from silent checks).

This is a utility skill: it ships its code in this folder and copies it into
the project. All logic lives in one skill-owned file; the single reach-in into
core is appending two callbacks to the hook arrays the Claude provider already
passes to the SDK.

| Tool | Pre-call message | Post-call message |
|------|------------------|-------------------|
| `Bash` | `🖥️ bash: <cmd-summary>` | `🖥️ bash: done in Xs` (only if > 3s) |
| `Read` / `Write` / `Edit` / `MultiEdit` | `📖 read: <path>` (debounced ×N) | — |
| `WebFetch` | `🌐 fetch: <domain>` (debounced ×N) | — |
| `WebSearch` / `Glob` / `Grep` | (skipped — too noisy) | — |
| `Task` / `Agent` (sub-agents) | `🤖 task: <description>` + 30s progress ticks | — |
| any failed tool | — | `❌ <label>: ✗ <reason>` |
| other / MCP tools | `🔧 <label>: <input-summary>` | — |

## Install

### Pre-flight

If all of the following are already present, skip to **Validate**:

- `container/agent-runner/src/hooks/tool-visibility.ts`
- `container/agent-runner/src/hooks/tool-visibility.test.ts`
- `container/agent-runner/src/hooks/tool-visibility-wiring.test.ts`
- an import of `preToolUseVisibility` in `container/agent-runner/src/providers/claude.ts`

Missing pieces — continue below. All steps are idempotent; re-running is safe.

### 1. Copy the hook module and its tests

Wholesale copies (owned entirely by this skill — user edits to these files
won't survive a re-run, as designed):

```bash
mkdir -p container/agent-runner/src/hooks
cp .claude/skills/add-tool-visibility/resources/tool-visibility.ts             container/agent-runner/src/hooks/tool-visibility.ts
cp .claude/skills/add-tool-visibility/resources/tool-visibility.test.ts        container/agent-runner/src/hooks/tool-visibility.test.ts
cp .claude/skills/add-tool-visibility/resources/tool-visibility-wiring.test.ts container/agent-runner/src/hooks/tool-visibility-wiring.test.ts
```

- `tool-visibility.ts` — the hook implementations (`preToolUseVisibility`,
  `postToolUseVisibility`) plus input summarizers, debouncing, and failure
  detection. Writes through core's `writeMessageOut()` with routing from
  `session_routing`; any failure inside the hook is swallowed so it can never
  kill an agent turn.
- `tool-visibility.test.ts` — behavior: drives the real hook callbacks against
  the real in-memory session DBs and asserts a deliverable chat row lands in
  `messages_out`. This is the guard for the hook's runtime consumption of core
  DB state (outbound schema, `session_routing`, `messages_in.kind`).
- `tool-visibility-wiring.test.ts` — the code edit in step 2: asserts (via the
  TS AST) that `claude.ts` imports both visibility hooks from
  `../hooks/tool-visibility.js` and that each is an element of the right hook
  array (`PreToolUse` / `PostToolUse` / `PostToolUseFailure`), placed after
  the core hook in each array. Delete or misplace the edit and this goes red.

### 2. Wire into the Claude provider

This is the skill's one integration point, in
`container/agent-runner/src/providers/claude.ts`. It is two appends: one
import line, and the two hook names appended to the three existing hook
arrays. All logic stays in the skill's own file.

**Re-run check:** if `preToolUseVisibility` already appears in the file, this
step is done — do not append a second time.

Add the import below the existing `../db/connection.js` import:

```typescript
import { postToolUseVisibility, preToolUseVisibility } from '../hooks/tool-visibility.js';
```

In the `hooks:` options object inside `ClaudeProvider.query()`, append the
visibility hooks to the three arrays — **after** the existing core hooks, so
`container_state` recording always runs first:

```typescript
        hooks: {
          PreToolUse: [{ hooks: [preToolUseHook, preToolUseVisibility] }],
          PostToolUse: [{ hooks: [postToolUseHook, postToolUseVisibility] }],
          PostToolUseFailure: [{ hooks: [postToolUseHook, postToolUseVisibility] }],
          PreCompact: [{ hooks: [createPreCompactHook(this.assistantName)] }],
        },
```

(`PreCompact` is unchanged — shown only to anchor the block.)

### 3. Validate

Run from your NanoClaw project root:

```bash
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit   # container typecheck — guards symbol/path drift
cd container/agent-runner
bun install                                                       # only needed if node_modules is missing
bun test src/hooks/                                               # behavior + wiring guards
cd ../..
```

All must be green before proceeding. Then rebuild the agent image and restart
so new sessions pick up the hooks:

```bash
./container/build.sh
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)              # Linux
# or: launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
```

Already-running container sessions keep their old image until they exit and
respawn; they pick up the visibility hooks on the next spawn.

## Configuration

None. No environment variables, no credentials, no per-group setup. The hooks
activate for every Claude-provider session that has a reply lane
(`session_routing`); agent-shared/internal sessions and scheduled-task
sessions stay silent by design.

## Next steps

In a wired chat, send a message that triggers a tool call (e.g. "list the
files in /etc"). The chat shows `🖥️ bash: ls /etc` before the agent's
final answer. Bash calls under 3 seconds produce no completion marker —
that's the spam guard, not a bug.

## Recipe entry

Independent — no dependency on other skills and no ordering constraint.
Applies to the Claude provider only; groups running another provider
(`agent_provider` ≠ claude) are unaffected. Needs the agent-image rebuild
(step 3) after apply; when composing several image-touching skills in one
recipe run, one rebuild at the end covers them all.

To back this skill out, follow [REMOVE.md](REMOVE.md).
