---
name: add-notion
description: Add Notion integration to NanoClaw. Connects the official Notion MCP server so the agent can search, read, create, and update Notion pages and databases.
---

# Add Notion Integration

Adds Notion workspace access to NanoClaw via the official `@notionhq/notion-mcp-server`. The agent gets tools to search, read, create, and update pages and databases.

## What This Adds

- **Search** — find pages and databases across the workspace
- **Read** — fetch page content, database entries, comments
- **Create** — create new pages and database entries
- **Update** — modify existing pages, update properties, add comments

## Prerequisites

User must have:
1. NanoClaw already set up and running
2. Docker installed and running

## Implementation Steps

Run all steps automatically. Only pause for user input when explicitly needed.

### 1. Get Notion Integration Token

Use `AskUserQuestion: Do you have a Notion internal integration token, or should I help you create one?`

**If they have one:**
Collect it now. It starts with `ntn_` or `secret_`.

**If they need one:**
Tell them:
> 1. Go to https://www.notion.so/profile/integrations/internal/form/new-integration
> 2. Give it a name (e.g. your assistant's name)
> 3. Select your workspace
> 4. Click **Submit**
> 5. Copy the **Internal Integration Secret**
>
> Then share pages with the integration:
> - Open any Notion page or database you want the bot to access
> - Click the `...` menu → **Connections** → Add your integration

Wait for the token.

### 2. Add Token to Environment

Add `NOTION_API_KEY` to `.env`:

```bash
if ! grep -q "NOTION_API_KEY=" .env 2>/dev/null; then
    echo "NOTION_API_KEY=\"${TOKEN_FROM_USER}\"" >> .env
else
    sed -i.bak "s/^NOTION_API_KEY=.*/NOTION_API_KEY=\"${TOKEN_FROM_USER}\"/" .env
fi
```

### 3. Update Container Runner Secrets

In `src/container-runner.ts`, find the `readSecrets()` function.

Add `'NOTION_API_KEY'` to the `readEnvFile()` call:

```typescript
const envSecrets = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'NOTION_API_KEY']);
```

And add the passthrough below the existing `ANTHROPIC_API_KEY` block:

```typescript
if (envSecrets.NOTION_API_KEY) {
  secrets.NOTION_API_KEY = envSecrets.NOTION_API_KEY;
}
```

### 4. Configure MCP Server in Agent Runner

In `container/agent-runner/src/index.ts`, find the `mcpServers` config object (inside the SDK session options).

Add the Notion MCP server alongside the existing `nanoclaw` server, gated on the API key:

```typescript
...(sdkEnv.NOTION_API_KEY ? {
  notion: {
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    env: {
      OPENAPI_MCP_HEADERS: JSON.stringify({
        'Authorization': `Bearer ${sdkEnv.NOTION_API_KEY}`,
        'Notion-Version': '2022-06-28',
      }),
    },
  },
} : {}),
```

Also add the Notion tool pattern to the `allowedTools` array:

```typescript
'mcp__notion__*'
```

### 5. Sync Agent Runner Source

The agent-runner source is copied per-group on first run and not updated automatically. Sync the updated source to existing groups:

```bash
cp container/agent-runner/src/index.ts data/sessions/*/agent-runner-src/index.ts 2>/dev/null || true
```

### 6. Update Group CLAUDE.md

Add Notion to the "What You Can Do" section in the main group's `CLAUDE.md`:

```markdown
- **Notion** — search, read, create, and update pages in the user's Notion workspace using `mcp__notion__*` tools
```

### 7. Clear Existing Session

Existing sessions won't discover new MCP tools. Clear the session so the agent starts fresh:

```bash
node -e "const db = require('better-sqlite3')('store/messages.db'); db.prepare(\"DELETE FROM sessions WHERE group_folder = 'main'\").run();"
```

### 8. Rebuild and Restart

```bash
./container/build.sh
npm run build
```

Restart the service:
```bash
# Linux
systemctl --user restart nanoclaw

# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### 9. Test

Tell the user to test:
> Send a message to your assistant: "Search my Notion for [something]"
>
> The assistant should use the Notion MCP tools to search the workspace.
>
> If the bot says it can't find Notion tools, the session may need clearing (step 7) or the agent-runner source may need syncing (step 5).

Check logs for Notion MCP server startup:
```bash
tail -30 logs/nanoclaw.log
```

## Troubleshooting

**Agent says Notion tools aren't available:**
- Session may be stale — clear it (step 7) and restart
- Agent-runner source may not be synced — run step 5
- Check that `NOTION_API_KEY` is in `.env` and not commented out

**Notion returns "unauthorized" or "restricted":**
- The integration needs access to specific pages. Open each page/database in Notion → `...` menu → **Connections** → add the integration.

**Container build fails:**
- Ensure the agent-runner TypeScript compiles: check for syntax errors in the MCP server config

## Uninstalling

1. Remove from `.env`: `sed -i.bak '/NOTION_API_KEY/d' .env`
2. Revert changes to `src/container-runner.ts` and `container/agent-runner/src/index.ts`
3. Remove Notion line from group `CLAUDE.md`
4. Rebuild: `./container/build.sh && npm run build`
5. Restart the service
