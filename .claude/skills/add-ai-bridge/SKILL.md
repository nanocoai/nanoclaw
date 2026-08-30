---
name: add-ai-bridge
description: Enable bidirectional communication between the NanoClaw agent and Claude Code (your admin AI). Claude Code can inject messages into the agent's next prompt, and the agent can write requests back to Claude Code via shared log files.
---

# Add AI Bridge

This skill sets up a lightweight inter-AI communication channel between your NanoClaw agent and Claude Code (your admin AI that manages the server).

**What it enables:**
- Claude Code can inject messages into the agent's prompt at the start of the next conversation
- The agent can write requests back to Claude Code (e.g. "check disk space", "how many containers are running?")
- Claude Code reads pending messages at the start of each session and responds asynchronously

This is useful when you want your assistant agent and Claude Code to collaborate — for example, the agent asks Claude Code to run a diagnostic, or Claude Code proactively alerts the agent about a system event.

---

## How It Works

Two log files in the group's `logs/` folder act as the communication channel:

| File | Direction | Purpose |
|------|-----------|---------|
| `groups/{folder}/logs/agent-inbox.log` | Claude Code → Agent | Claude Code writes here; NanoClaw injects content into the agent's next prompt, then clears the file |
| `groups/{folder}/logs/agent-to-admin.log` | Agent → Claude Code | Agent appends messages here; Claude Code reads at session start |

NanoClaw checks for inbox content **before every agent invocation**. If content exists, it's prepended to the prompt as:

```
[Message from Claude Code]
<content>
[End of Claude Code message]

<original prompt>
```

---

## Step 1 — Patch `src/index.ts`

Find the line in `processGroupMessages` where `prompt` is built from `formatMessages(missedMessages)`, and add the inbox injection block immediately after:

```typescript
let prompt = formatMessages(missedMessages);

// Inject admin inbox: if Claude Code left a message for the agent, prepend it
const inboxPath = path.join(GROUPS_DIR, group.folder, 'logs', 'agent-inbox.log');
try {
  const inbox = fs.readFileSync(inboxPath, 'utf-8').trim();
  if (inbox) {
    prompt = `[Message from Claude Code]\n${inbox}\n[End of Claude Code message]\n\n${prompt}`;
    fs.writeFileSync(inboxPath, '');
    logger.info({ group: group.name }, 'Injected Claude Code inbox message into prompt');
  }
} catch {
  // No inbox file — normal case
}
```

Make sure `fs` and `path` are already imported (they are in the default NanoClaw setup).

---

## Step 2 — Create the log files

Create the log directory and files for the group you want to bridge. Replace `main` with your group folder name if different:

```bash
mkdir -p groups/main/logs
touch groups/main/logs/agent-inbox.log
touch groups/main/logs/agent-to-admin.log
```

---

## Step 3 — Update the agent's CLAUDE.md

Add this section to `groups/{folder}/CLAUDE.md` so the agent knows how to send messages back to Claude Code:

```markdown
## Communication with Claude Code (Admin AI)

Messages from Claude Code are automatically injected at the top of your prompt between
`[Message from Claude Code]` and `[End of Claude Code message]` tags.

To send a message to Claude Code, append to the log file:

\`\`\`bash
echo "[AGENT-TO-ADMIN] [QUESTION] Your question here" >> /workspace/group/logs/agent-to-admin.log
echo "- Agent [$(date '+%Y-%m-%d %H:%M')]" >> /workspace/group/logs/agent-to-admin.log
\`\`\`

Message types: [INFO], [QUESTION], [REQUEST], [URGENT]
```

---

## Step 4 — Update your Claude Code CLAUDE.md

Add this section to the project-level `CLAUDE.md` so Claude Code reads pending messages at the start of every session:

```markdown
## Inter-AI Communication

At the start of each session, read `groups/main/logs/agent-to-admin.log` for pending
messages from the agent. Respond to any [QUESTION] or [REQUEST] entries by writing to
`groups/main/logs/agent-inbox.log` — the content will be injected into the agent's
next prompt automatically.

Response format: `[CLAUDE-CODE-RESPONSE] [STATUS] Message [YYYY-MM-DD HH:MM]`
```

---

## Step 5 — Rebuild and restart

```bash
npm run build
# Then restart the NanoClaw service
```

---

## Usage

**Claude Code → Agent** (write to inbox, agent picks it up on next message):

```bash
echo "RAM is currently at 85%, consider deferring heavy tasks" > groups/main/logs/agent-inbox.log
```

**Agent → Claude Code** (appended automatically by the agent, read at next Claude Code session):

```
[AGENT-TO-ADMIN] [QUESTION] How many containers are currently running?
- Agent [2026-02-20 18:00]
```

---

## Security Notes

- The inbox file is **cleared after each injection** — no message is delivered twice
- The agent should only send read/diagnostic requests to Claude Code, not destructive commands
- Both files are local to your machine; no network communication involved
- All exchanges are logged in the files for audit purposes

---

## Optional: Shared Sync Log

For a shared activity log visible to both AIs, create:

```bash
touch groups/main/logs/ai-sync.log
```

Both Claude Code and the agent can append timestamped entries using the format:

```
[YYYY-MM-DD HH:MM] [SOURCE] [TYPE] Message
```

Example:
```
[2026-02-20 18:30] [AGENT] [TASK] Briefing sent (12 emails processed)
[2026-02-20 18:31] [CLAUDE-CODE] [ALERT] RAM usage 85% on container nanoclaw-main-XXX
[2026-02-20 18:32] [AGENT] [INFO] User notified of RAM alert
```
