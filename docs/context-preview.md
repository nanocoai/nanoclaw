# Context Preview

`scripts/context-preview.ts` renders the **exact context an agent sees** for a
given scenario — the composed CLAUDE.md with every `@`-import expanded, the
runtime system-prompt addendum, the SDK options, the MCP tool surface, the
container mount table, and the exact prompt string the poll loop hands the
provider.

```bash
pnpm exec tsx scripts/context-preview.ts <scenario> [flags]
```

Use it to answer questions like *"when a scheduled task fires, does the agent
have enough context to know it must address the user explicitly?"* or *"what
exactly changes in the agent's context when I edit
`container/CLAUDE.md` / a skill's `instructions.md` / the formatter?"* —
without spawning a container or sending a real message.

## Fidelity model

The tool **imports the production code paths instead of duplicating strings**,
so any edit to the composer, formatter, addendum builder, instructions files,
or SDK options is reflected on the next run:

- Host half (Node/tsx): runs the real scaffold + spawn steps —
  `initGroupFilesystem` (the once-per-lifetime creation scaffold), then
  `materializeContainerJson` and `buildMounts` (which calls
  `syncSkillSymlinks` + `composeGroupClaudeMd`) — in a throwaway sandbox with
  an in-memory central DB. Scenario messages are staged with the same writers the host uses
  (`writeSessionMessage`, `insertTaskRow`, `taskPromptWithLog`,
  `writeDestinations`, `writeSessionRouting`). **Nothing in the live install
  is read-write touched**; `--group` opens `data/v2.db` read-only.
- Container half (Bun): `container/agent-runner/scripts/context-preview-runner.ts`
  seeds the in-memory test session DBs with the staged rows and drives the
  **real `runPollLoop`** with a capturing provider — batching,
  `on_wake` first-poll gating, and the accumulate gate are all production
  behavior. Slash-command splitting follows the previewed provider's
  native-slash-commands capability (native for Claude; XML-wrapped
  otherwise). SDK options come from
  `ClaudeProvider.buildQueryOptions()`; the addendum from
  `buildSystemPromptAddendum()`; the tool list from the registered
  `McpToolDefinition`s.

The `@`-import expansion resolves each fragment symlink through the actual
mount table returned by `buildMounts`, i.e. the same container-path → host-path
mapping the real spawn uses.

## Scenarios

| Scenario | What it stages |
|----------|----------------|
| `first-message` | Fresh session, first user chat message (default) |
| `followup` | Existing session: prior completed turn + stored continuation → SDK `resume` |
| `accumulate` | Group chat: three `trigger=0` context-only rows riding in with a `trigger=1` mention |
| `task-fire` | A due task row exactly as `ncl tasks create` writes it (isolated task session, run-log directive appended) |
| `on-wake` | The `on_wake=1` restart message `ncl groups restart --message` / self-mod apply writes |
| `a2a` | A message from another agent group, as `performAgentRoute` writes it (verbatim `{text}`, `source_session_id` return path) |
| `subagent` | No messages — explains SDK-native subagents (Task tool) and points at the surfaces that enable them |

## Flags

| Flag | Meaning |
|------|---------|
| `--group <folder\|id>` | Preview a **real agent group**: its container config, cli_scope, persona, CLAUDE.local.md, template skills, and destinations are snapshotted (read-only) from `data/v2.db` and `groups/<folder>/`. Default is a synthetic group named `preview`. |
| `--message <text>` | Override the staged message/task/wake text |
| `--sender <name>` / `--channel <type>` | Sender display name and channel type for chat scenarios |
| `--section <name>` | Print one section: `scenario`, `environment`, `claude-md`, `system-prompt`, `sdk-options`, `mcp-tools`, `prompt`, `notes` |
| `--json` | Machine-readable dump of everything |
| `--keep` | Keep the sandbox dir for inspection (path printed to stderr) |

## What is NOT simulated

The preview starts at the session inbound.db — everything upstream of it and
some side flows are out of scope. When reasoning about those, read the real
paths:

- **Router-side gating** — engage-mode evaluation (mention/pattern),
  `unknown_sender_policy`, command gating (`/help` filtering, admin denial),
  and channel-registration escalation happen before a row is ever written
  (`src/router.ts`, `src/command-gate.ts`). The preview stages rows as if they
  passed.
- **Content enrichment by real adapters** — the chat-sdk bridge writes the
  full message serialization (author, replyTo, attachments) into `content`
  (`src/channels/chat-sdk-bridge.ts` `messageToInbound`); the preview stages
  the minimal `{text, sender, senderId}` shape.
- **Attachment staging** — base64 → `inbox/<msgId>/<file>` extraction and
  safety renames (`src/session-manager.ts` `extractAttachmentFiles`).
- **Approval flows** — approval-outcome notifications
  (`src/modules/approvals/`), the a2a message gate, and the `ncl` cli_request
  round-trip all inject further context into sessions.
- **Task pre-scripts** — a task's `script` runs before the wake and injects
  `scriptOutput` into the `<task>` block
  (`container/agent-runner/src/scheduling/task-script.ts`).
- **Real container env** — OneCLI proxy vars, egress lockdown, and image
  contents; the SDK-options `env` is rendered as the provider-set keys plus a
  note.
- **Non-default providers** — the SDK options section is Claude-specific;
  providers that own their agent surfaces (e.g. Codex on the `providers`
  branch) skip the composed-CLAUDE.md path entirely.

## Maintenance seams

These production exports exist specifically so no agent-visible string is
duplicated. If you rename or restructure them, update both halves:

- `ClaudeProvider.buildQueryOptions()` (`container/agent-runner/src/providers/claude.ts`)
- `formatMessagesWithCommands` (`container/agent-runner/src/poll-loop.ts`)
- `taskPromptWithLog` (`src/cli/resources/tasks.ts`)
- `listRegisteredTools` (`container/agent-runner/src/mcp-tools/server.ts`)
- `setTestConfig` (`container/agent-runner/src/config.ts`)
- `initTestSessionDb` (`container/agent-runner/src/db/connection.ts`)

Two pieces of wiring are mirrored (not imported) by the Bun harness and must
be kept in sync by hand:

- the tool-module import list from `container/agent-runner/src/mcp-tools/index.ts`
  (that file's header points back here)
- the `mcpServers`/`cwd` assembly from `container/agent-runner/src/index.ts`
  `main()`
