---
name: add-image-sending
description: Allow the agent to send images to users (e.g. browser screenshots, charts, documents). Adds an optional image_path parameter to the send_message MCP tool. Use when the user wants their agent to send screenshots, or when agent-browser screenshot output needs to be surfaced to the chat.
---

# Add Image Sending

This skill adds outbound image support: the agent can send images (e.g. browser screenshots) to the user via `mcp__nanoclaw__send_message(text="...", image_path="/tmp/shot.png")`.

It does not require any external API keys or new dependencies.

## What this adds

- `image_path` parameter on the `send_message` MCP tool (agent-side)
- `sendImage` method on `WhatsAppChannel` (host-side)
- IPC plumbing to carry base64-encoded images from container → host → WhatsApp
- Updated `agent-browser/SKILL.md` example showing the screenshot → send workflow

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `add-image-sending` is in `applied_skills`, skip to Phase 3 (Verify). The code changes are already in place.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-image-sending
```

This deterministically:
- Adds `sendImage?` to the `Channel` interface in `src/types.ts`
- Adds `sendImage` method to `WhatsAppChannel` in `src/channels/whatsapp.ts`
- Adds 3 `sendImage` tests to `src/channels/whatsapp.test.ts`
- Adds `sendImage?` to `IpcDeps` and `type: 'image'` handler in `src/ipc.ts`
- Wires `sendImage` into `startIpcWatcher` in `src/index.ts`
- Adds `image_path` parameter to the `send_message` MCP tool in `container/agent-runner/src/ipc-mcp-stdio.ts`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/types.ts.intent.md` — what changed in types.ts
- `modify/src/channels/whatsapp.ts.intent.md` — what changed in whatsapp.ts
- `modify/src/channels/whatsapp.test.ts.intent.md` — what changed in whatsapp.test.ts
- `modify/src/ipc.ts.intent.md` — what changed in ipc.ts
- `modify/src/index.ts.intent.md` — what changed in index.ts
- `modify/container/agent-runner/src/ipc-mcp-stdio.ts.intent.md` — what changed in ipc-mcp-stdio.ts

### Validate code changes

```bash
npm test
npm run build
```

All existing tests must pass plus the 3 new `sendImage` tests.

### Update agent-browser SKILL.md example

Find the section **"Example: Taking and sending a screenshot to the user"** in `container/skills/agent-browser/SKILL.md` and update the final step to use `image_path`:

```markdown
# 3. Send it — pass the same path to image_path
mcp__nanoclaw__send_message(text="Here's what I see", image_path="/tmp/shot.png")
```

## Phase 3: Rebuild container and restart

```bash
bash container/build.sh
```

Then restart NanoClaw:

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

## Phase 4: Verify

Tell the user to send this message in their main WhatsApp chat:

> Take a screenshot of example.com and send it to me

The agent should take a screenshot with `agent-browser` and send it back as a WhatsApp image message.

If the image doesn't arrive, check logs for `IPC image sent` or `sendImage not supported`.
