---
name: self-customize
description: Customize your own agent — install packages, add MCP servers, edit memory or standing instructions. Use when the user asks you to add a feature, install a tool, or modify how you work. Source-code changes are operator work on this deployment.
---

# Self-Customization

You can modify your own environment. Different kinds of changes have different workflows.

## Decision Tree

**What needs to change?**

- **Memory or standing instructions** → Edit `memory/` or `instructions.prepend.md` directly, no approval needed. The workspace is persisted on the host. The composed provider document (`CLAUDE.md` or `AGENTS.md`) is regenerated every spawn and must not be edited.
- **System package (apt) or global npm package** → `install_packages`. Requires admin approval. On approval, image rebuild + container restart happen automatically.
- **MCP server** → `add_mcp_server`. Requires admin approval. On approval, container restarts with the new server wired up (no rebuild — bun runs TS directly).
- **Your source code, Dockerfile, or a new specialist capability** → Not self-serviceable on this deployment. Tell the user concretely what change is needed (files, behavior, acceptance criteria) so they can raise it with an operator.

## Example: Adding a New MCP Tool to Yourself

User: "Can you add a tool for reading RSS feeds?"

1. Check [mcp.so](https://mcp.so) for an existing RSS MCP server
2. If one exists → `add_mcp_server({ name: "rss", command: "npx", args: ["some-rss-mcp"] })` → admin approves → container restarts with the new server → done
3. If nothing suitable exists → describe what you looked for and what a suitable tool would do, and ask the user to raise it with an operator — source-level tool additions are operator work on this deployment

## Example: Installing a System Tool

User: "Can you transcribe audio?"

1. Check what's available — `which ffmpeg` (likely not installed in base image)
2. Decide approach: `@xenova/transformers` (npm, workspace-local) or `whisper.cpp` (apt + compile)
3. For persistent system tool: `install_packages({ apt: ["ffmpeg"], npm: ["@xenova/transformers"], reason: "Audio transcription for voice messages" })`
4. Wait for admin approval — on approve, the image is rebuilt and your container is restarted automatically
5. Test the new capability once the container restarts

## When NOT to Self-Customize

- **The change is for a one-off task** — just do it in your workspace, don't modify the container
- **The request is ambiguous** — ask the user what they actually need before requesting installs
- **You don't know if it will work** — prototype in your workspace first (`pnpm install` in `/workspace/agent/`), then promote to container-level install if it proves useful
