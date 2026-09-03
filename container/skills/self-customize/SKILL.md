---
name: self-customize
description: Customize your own agent — add capabilities, install packages, add MCP servers, edit code or CLAUDE.md. Use when the user asks you to add a feature, install a tool, or modify how you work. For non-trivial code changes, delegate to a builder agent via create_agent.
---

# Self-Customization

You can modify your own environment. Different kinds of changes have different workflows.

## Decision Tree

**What needs to change?**

- **Memory or standing instructions** → Edit `memory/` or `instructions.prepend.md` directly, no approval needed. The workspace is persisted on the host. The composed provider document (`CLAUDE.md` or `AGENTS.md`) is regenerated every spawn and must not be edited.
- **System package (apt) or global npm package** → `install_packages`. Requires admin approval. On approval, image rebuild + container restart happen automatically.
- **MCP server** → `add_mcp_server`. Requires admin approval. On approval, container restarts with the new server wired up (no rebuild — bun runs TS directly).
- **Your source code or Dockerfile** → Delegate to a builder agent via `create_agent` (see below).
- **A new specialist capability** → `create_agent` to spin up a dedicated agent for it.

## Workflow: Code Changes via Builder Agent

For anything that requires editing source files (your own code, Dockerfile, etc.), **do not edit directly** — delegate to a builder agent. This gives the user a reviewable boundary and keeps your main session focused.

1. Describe what you need changed in concrete terms (files, behavior, acceptance criteria)
2. Call `create_agent({ name: "Builder", instructions: "<builder prompt>" })` — the returned agent group ID is your builder
3. Call `send_to_agent({ agentGroupId, text: "<task description with specific files and changes>" })`
4. The builder works in its own container, makes the changes, and reports back
5. You review the builder's summary and confirm with the user. Source-code edits inside `/app/src` are picked up automatically on the next container start — no rebuild step needed (bun runs TS directly). If the builder also installed packages, its own `install_packages` approval will have rebuilt the image.

### Builder Agent Instructions (use as CLAUDE.md when creating)

```
You are a builder agent. Your job is to make precise, minimal code changes to NanoClaw source files when the main agent requests it.

## Rules

- **Minimal scope.** Only change what was requested. Do not refactor surrounding code, "improve" unrelated files, or add features not asked for.
- **Diff size limits.** Reject any change that exceeds 200 new lines or 150 modified lines in a single task. If the change is larger, push back and ask for it to be split into smaller tasks.
- **Read before writing.** Always read the target file fully before editing. Understand the existing patterns.
- **Test if possible.** If there are relevant tests, run them after your change.
- **Report back.** When done, use send_to_agent to tell the requesting agent: (a) what files you changed, (b) a summary of the changes, (c) any follow-up needed (rebuild, tests, migrations).
- **No silent failures.** If you can't complete the task, explain why — don't produce partial work without flagging it.

## Safety

- Never edit files outside the requested scope
- Never commit or push anything
- Never modify secrets, credentials, or .env files
- If a change would break existing tests, stop and report
```

## Diff Size Limits — Why

A 50-line focused change is reviewable. A 500-line sweep is not. Hard limits force the agent to decompose work into reviewable chunks, which:

- Makes human approval meaningful (you can actually read 150 lines)
- Catches runaway edits early (if the first task hits the limit, the scope was wrong)
- Forces clear acceptance criteria per task

The limits are **per builder task**, not per session. A 500-line feature is fine as 4 sequential builder tasks of ~125 lines each, each with its own scope.

## Example: Adding a New MCP Tool to Yourself

User: "Can you add a tool for reading RSS feeds?"

1. Check [mcp.so](https://mcp.so) for an existing RSS MCP server
2. If one exists → `add_mcp_server({ name: "rss", command: "npx", args: ["some-rss-mcp"] })` → admin approves → container restarts with the new server → done
3. If nothing suitable exists → delegate to a builder agent:
   - `create_agent({ name: "RSS Tool Builder", instructions: "<builder prompt from above>" })`
   - `send_to_agent({ agentGroupId, text: "Add an MCP tool 'read_rss' to container/agent-runner/src/mcp-tools/. It should fetch an RSS URL and return the latest N items. Register it in mcp-tools/index.ts. Target: <200 new lines." })`
   - Wait for builder's report — new tool code is picked up on the next container start (bun runs TS directly)

## Example: Installing a System Tool

User: "Can you transcribe audio?"

1. Check what's available — `which ffmpeg` (likely not installed in base image)
2. Decide approach: `@xenova/transformers` (npm, workspace-local) or `whisper.cpp` (apt + compile)
3. For persistent system tool: `install_packages({ apt: ["ffmpeg"], npm: ["@xenova/transformers"], reason: "Audio transcription for voice messages" })`
4. Wait for admin approval — on approve, the image is rebuilt and your container is restarted automatically
5. Test the new capability once the container restarts

## When NOT to Self-Customize

- **The change is for a one-off task** — just do it in your workspace, don't modify the container
- **The request is ambiguous** — ask the user what they actually need before spinning up builders or requesting installs
- **You don't know if it will work** — prototype in your workspace first (`pnpm install` in `/workspace/agent/`), then promote to container-level install if it proves useful
