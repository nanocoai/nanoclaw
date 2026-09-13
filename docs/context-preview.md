# Context Preview

`scripts/context-preview.ts` renders the **exact context an agent sees** for a
given scenario — the composed project document (`/workspace/agent/CLAUDE.md`,
every instruction source inlined), the runtime system-prompt addendum, the
SDK options, the MCP tool surface, the container mount table, and the exact
prompt string the poll loop hands the provider.

```bash
pnpm exec tsx scripts/context-preview.ts <scenario> [flags]
```

Use it to answer questions like *"when a scheduled task fires, does the agent
have enough context to know it must address the user explicitly?"*, *"what
exactly changes in the agent's context when I edit `container/CLAUDE.md` / a
module's `instructions.md` / the formatter?"*, or *"what did the agent
actually read on that turn?"* (replay a real session dump) — without spawning
a container or sending a real message.

## Fidelity model

The tool **imports the production code paths instead of duplicating strings**,
so any edit to the composer, formatter, addendum builder, instruction sources,
or SDK options is reflected on the next run:

- Host half (Node/tsx): runs the real scaffold + spawn steps, in spawn order —
  `initGroupFilesystem` (the once-per-lifetime creation scaffold; it stages
  `--persona-file` through `stageGroupPersona`), `materializeContainerJson`,
  `resolveProviderContribution` (which realizes the provider's surfaces and
  composes the project document via `composeGroupProjectDoc`), then
  `buildMounts` — in a throwaway sandbox with an in-memory central DB
  (`initTestDb` + `runMigrations`). Scenario rows are staged with the same
  writers the host uses (`writeSessionMessage`, `createScheduledTask`,
  `writeDestinations`, `writeSessionRouting`). **Nothing in the live install
  is read-write touched**; `--group` opens `data/v2.db` read-only.
- Container half (Bun): `container/agent-runner/scripts/context-preview-runner.ts`
  parses the staged `container.json` with `runnerConfigFromRaw`, seeds the
  in-memory test session DBs (`initTestSessionDb`) with the staged rows, and
  drives the **real `runPollLoop`** with a capturing provider under the
  previewed provider's runtime contract — batching, `on_wake` first-poll
  gating, the accumulate gate, and slash-command splitting are all production
  behavior. The addendum comes from `buildSystemPromptAddendum()` in the mode
  `getTaskSeriesId()` derives from the staged session routing (task mode for
  task sessions, exactly as `index.ts` does); SDK options from a provider
  built through `createProvider('claude')` + `ClaudeProvider.buildQueryOptions()`;
  the tool list from `listRegisteredTools()`.

## Scenarios

| Scenario | What it stages |
|----------|----------------|
| `first-message` | Fresh session, first user chat message (default) |
| `followup` | Existing session: prior completed turn + stored continuation → SDK `resume` |
| `accumulate` | Group chat: three `trigger=0` context-only rows riding in with a `trigger=1` mention |
| `task-fire` | A due task row exactly as `ncl tasks create` writes it (`createScheduledTask`: isolated per-series task session; the task contract is rendered in the system prompt's task mode) |
| `on-wake` | The `on_wake=1` restart message `ncl groups restart --message` / self-mod apply writes |
| `a2a` | A message from another agent group, as `performAgentRoute` writes it (verbatim `{text}`, `source_session_id` return path) |
| `subagent` | No messages — explains SDK-native subagents (Task tool) and points at the surfaces that enable them |

## Flags

| Flag | Meaning |
|------|---------|
| `--group <folder\|id>` | Preview a **real agent group**: its container config, cli_scope, persona, plugins, and destinations are snapshotted (read-only) from `data/v2.db` and `groups/<folder>/`. Default is a synthetic group named `preview`. |
| `--persona-file <path>` | Stage this file as the group's standing instructions (`instructions.prepend.md`, the file the composer leads the document with). Replaces the group's own persona for the run. |
| `--replay <jsonl>` | Stage real inbound rows from a **session dump** instead of the scenario's synthetic message — one `{"recordType": …, "record": {…}}` object per line, the mailbox record format (`InboundRecord` fields: `id, sequence, kind, timestamp, trigger, platformId, channelType, threadId, content, …`). `sessionRouting`, `destination` and `state` (`continuation:<provider>`) records in the dump are staged too, so the `from=` names, the addendum's destination map and the SDK `resume` match the real session. Only with `first-message` (default) or `followup`. |
| `--turn <seq\|a-b>` | With `--replay`: which record(s) form the pending batch. Records before the turn are staged as completed history (and the dump's continuation applies); records after it are dropped. Default: the last inbound record. |
| `--message <text>` | Override the staged message/task/wake text |
| `--sender <name>` / `--channel <type>` | Sender display name and channel type for chat scenarios |
| `--section <name>` | Print one section: `scenario`, `environment`, `claude-md`, `system-prompt`, `sdk-options`, `mcp-tools`, `prompt`, `notes` |
| `--json` | Machine-readable dump of everything (`claudeMd`, `systemPrompt`, `sdkOptions`, `mcpTools`, `prompt`, plus `batch`, `mounts`, `persona`, `replay`, `notes`) |
| `--keep` | Keep the sandbox dir for inspection (path printed to stderr) |

The `claude-md` section prints a section index (`# <name>: <words> words`) before
the full document — the same shape as `awk` over the file inside a running pod,
so the two can be compared line by line.

## Example: a real turn from an e2e lane

Given a session dump in the mailbox record format (e.g. what a lane's
`context-live.sh <agentGroupId> <sessionId>` reads from its S3 mailbox — inbound
records, the `sessionRouting` and `destination` records, and the
`continuation:claude` state row) and the persona the lane's composer staged for
that session:

```bash
TZ=UTC pnpm exec tsx scripts/context-preview.ts \
  --persona-file /path/to/persona.md \
  --replay /path/to/session-dump.jsonl --turn 22 \
  --section prompt
```

renders the exact `<message …>` block of record #22, with the dump's stored
continuation as the SDK `resume` and `from="<the session's destination>"`.
`--section claude-md` then prints the composed document whose `Persona` body
is byte-identical to the staged file; compare its section index with the pod's
(`kubectl exec … -- awk '/^# /…' /workspace/agent/CLAUDE.md`). Set `TZ` to the
deployment's timezone so `<context timezone>` and `time=` match the pod.

Run the tool from the host tree that produced the deployment (or a copy of it)
so the instruction sources it composes are the deployed ones.

## What is NOT simulated

The preview starts at the session inbound mailbox — everything upstream of it
and some side flows are out of scope. When reasoning about those, read the
real paths:

- **Router-side gating** — engage-mode evaluation (mention/pattern),
  `unknown_sender_policy`, command gating (`/help` filtering, admin denial),
  and channel-registration escalation happen before a row is ever written
  (`src/router.ts`, `src/command-gate.ts`). The preview stages rows as if they
  passed.
- **Content enrichment by real adapters** — the chat-sdk bridge writes the
  full message serialization (author, replyTo, attachments) into `content`
  (`src/channels/chat-sdk-bridge.ts` `messageToInbound`); synthetic scenarios
  stage the minimal `{text, sender, senderId}` shape. `--replay` renders real
  rows.
- **Attachment staging** — base64 → `inbox/<msgId>/<file>` extraction and
  safety renames (`src/session-manager.ts` `extractAttachmentFiles`) run, but
  replayed dumps normally carry paths, not payloads.
- **Approval flows** — approval-outcome notifications
  (`src/modules/approvals/`), the a2a message gate, and the `ncl` cli_request
  round-trip all inject further context into sessions.
- **Task pre-scripts** — a task's `script` runs before the wake and injects
  `scriptOutput` into the `<task>` block
  (`container/agent-runner/src/scheduling/task-script.ts`).
- **Memory session context** — the provider's session-start hook
  (`container/agent-runner/src/memory/hook.ts`) injects the memory index on a
  fresh context window; the preview shows the hook's env, not its output.
- **Real container env** — OneCLI proxy vars, egress lockdown, and image
  contents; the SDK-options `env` is rendered as the keys the provider itself
  sets plus a note.
- **Non-default providers** — the SDK options section is Claude-specific;
  providers that own their agent surfaces skip the composed-CLAUDE.md path
  entirely.
- **Deployment-specific composers** — a deployment whose init container
  composes the workspace from a release bundle may add or drop instruction
  sources relative to the source tree; run the tool on that tree to compare.

## Maintenance seams

These production exports exist specifically so no agent-visible string is
duplicated. If you rename or restructure them, update both halves — the smoke
test (`scripts/context-preview.test.ts`, runs `first-message --json` under
vitest with the Bun half) goes red when one drifts:

- `ClaudeProvider.buildQueryOptions()` (`container/agent-runner/src/providers/claude.ts`)
- `formatMessagesWithCommands` (`container/agent-runner/src/poll-loop.ts`)
- `listRegisteredTools` (`container/agent-runner/src/mcp-tools/server.ts`)
- `setTestConfig` + `runnerConfigFromRaw` (`container/agent-runner/src/config.ts`)
- `initTestSessionDb` (`container/agent-runner/src/mailbox/sqlite/connection.ts`)
- `createScheduledTask` / `prepareScheduledTask` (`src/modules/scheduling/create.ts`)
  and `resolveProviderContribution` / `buildMounts` (`src/container-runner.ts`)
  — host-side production functions the tool calls directly.

The tool-module list is not mirrored: the Bun harness reads the side-effect
`import './…'` lines of `container/agent-runner/src/mcp-tools/index.ts` (the
barrel cannot be imported — it starts the MCP server) and loads exactly those,
so an installed or removed tool module shows up on the next run. One piece of
wiring is mirrored (not imported) and must be kept in sync by hand:

- the `mcpServers`/`cwd` assembly from `container/agent-runner/src/index.ts`
  `main()`
