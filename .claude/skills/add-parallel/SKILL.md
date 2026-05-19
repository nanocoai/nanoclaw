# Add Parallel AI Integration

Adds Parallel AI MCP integration to NanoClaw for advanced web research capabilities.

## What This Adds

- **Quick Search** - Fast web lookups using Parallel Search API (free to use)
- **Deep Research** - Comprehensive analysis using Parallel Task API (asks permission)
- **Non-blocking Design** - Uses NanoClaw scheduler for result polling (no container blocking)

## Prerequisites

User must have:
1. Parallel AI API key from https://platform.parallel.ai
2. NanoClaw already set up and running
3. Docker installed and running

## Implementation Steps

Run all steps automatically. Only pause for user input when explicitly needed.

### 1. Get Parallel AI API Key

Use `AskUserQuestion: Do you have a Parallel AI API key, or should I help you get one?`

**If they have one:**
Collect it now.

**If they need one:**
Tell them:
> 1. Go to https://platform.parallel.ai
> 2. Sign up or log in
> 3. Navigate to API Keys section
> 4. Create a new API key
> 5. Copy the key and paste it here

Wait for the API key.

### 2. Add API Key to Environment

Add `PARALLEL_API_KEY` to `.env`:

```bash
# Check if .env exists, create if not
if [ ! -f .env ]; then
    touch .env
fi

# Add PARALLEL_API_KEY if not already present
if ! grep -q "PARALLEL_API_KEY=" .env; then
    echo "PARALLEL_API_KEY=${API_KEY_FROM_USER}" >> .env
    echo "✓ Added PARALLEL_API_KEY to .env"
else
    # Update existing key
    sed -i.bak "s/^PARALLEL_API_KEY=.*/PARALLEL_API_KEY=${API_KEY_FROM_USER}/" .env
    echo "✓ Updated PARALLEL_API_KEY in .env"
fi
```

Verify:
```bash
grep "PARALLEL_API_KEY" .env | head -c 50
```

### 3. Update Container Runner

Add `PARALLEL_API_KEY` to allowed environment variables in `src/container-runner.ts`:

Find the line:
```typescript
const allowedVars = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
```

Replace with:
```typescript
const allowedVars = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'PARALLEL_API_KEY'];
```

### 4. Configure MCP Servers in Agent Runner

Update `container/agent-runner/src/index.ts`:

Find the section where `mcpServers` is configured (around line 237-252):
```typescript
const mcpServers: Record<string, any> = {
  nanoclaw: ipcMcp
};
```

Add Parallel AI MCP servers after the nanoclaw server:
```typescript
const mcpServers: Record<string, any> = {
  nanoclaw: ipcMcp
};

// Add Parallel AI MCP servers if API key is available
const parallelApiKey = process.env.PARALLEL_API_KEY;
if (parallelApiKey) {
  mcpServers['parallel-search'] = {
    type: 'http',  // REQUIRED: Must specify type for HTTP MCP servers
    url: 'https://search-mcp.parallel.ai/mcp',
    headers: {
      'Authorization': `Bearer ${parallelApiKey}`
    }
  };
  mcpServers['parallel-task'] = {
    type: 'http',  // REQUIRED: Must specify type for HTTP MCP servers  
    url: 'https://task-mcp.parallel.ai/mcp',
    headers: {
      'Authorization': `Bearer ${parallelApiKey}`
    }
  };
  log('Parallel AI MCP servers configured');
} else {
  log('PARALLEL_API_KEY not set, skipping Parallel AI integration');
}
```

Also update the `allowedTools` array to include Parallel MCP tools (around line 242-248):
```typescript
allowedTools: [
  'Bash',
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch',
  'mcp__nanoclaw__*',
  'mcp__parallel-search__*',
  'mcp__parallel-task__*'
],
```

### 5. Add Usage Instructions to CLAUDE.md

Add Parallel AI usage instructions to `groups/main/CLAUDE.md`:

Find the "## What You Can Do" section and add after the existing bullet points:
```markdown
- Use Parallel AI for web research and deep learning tasks
```

Then add a new section after "## What You Can Do":
```markdown
## Web Research Tools

You have access to two Parallel AI research tools:

### Quick Web Search (`mcp__parallel-search__search`)
**When to use:** Freely use for factual lookups, current events, definitions, recent information, or verifying facts.

**Examples:**
- "Who invented the transistor?"
- "What's the latest news about quantum computing?"
- "When was the UN founded?"
- "What are the top programming languages in 2026?"

**Speed:** Fast (2-5 seconds)
**Cost:** Low
**Permission:** Not needed - use whenever it helps answer the question

### Deep Research (`mcp__parallel-task__create_task_run`)
**When to use:** Comprehensive analysis, learning about complex topics, comparing concepts, historical overviews, or structured research.

**Examples:**
- "Explain the development of quantum mechanics from 1900-1930"
- "Compare the literary styles of Hemingway and Faulkner"
- "Research the evolution of jazz from bebop to fusion"
- "Analyze the causes of the French Revolution"

**Speed:** Slower (1-20 minutes depending on depth)
**Cost:** Higher (varies by processor tier)
**Permission:** ALWAYS use `AskUserQuestion` before using this tool

**How to ask permission:**
```
AskUserQuestion: I can do deep research on [topic] using Parallel's Task API. This will take 2-5 minutes and provide comprehensive analysis with citations. Should I proceed?
```

**After permission - DO NOT BLOCK! Use scheduler instead:**

1. Create the task using `mcp__parallel-task__create_task_run`
2. Get the `run_id` from the response
3. Create a polling scheduled task using `mcp__nanoclaw__schedule_task`:
   ```
   Prompt: "Check Parallel AI task run [run_id] and send results when ready.

   1. Use the Parallel Task MCP to check the task status
   2. If status is 'completed', extract the results
   3. Send results to user with mcp__nanoclaw__send_message
   4. Use mcp__nanoclaw__complete_scheduled_task to mark this task as done

   If status is still 'running' or 'pending', do nothing (task will run again in 30s).
   If status is 'failed', send error message and complete the task."

   Schedule: interval every 30 seconds
   Context mode: isolated
   ```
4. Send acknowledgment with tracking link
5. Exit immediately - scheduler handles the rest

### Choosing Between Them

**Use Search when:**
- Question needs a quick fact or recent information
- Simple definition or clarification
- Verifying specific details
- Current events or news

**Use Deep Research (with permission) when:**
- User wants to learn about a complex topic
- Question requires analysis or comparison
- Historical context or evolution of concepts
- Structured, comprehensive understanding needed
- User explicitly asks to "research" or "explain in depth"

**Default behavior:** Prefer search for most questions. Only suggest deep research when the topic genuinely requires comprehensive analysis.
```

### 6. Rebuild Container

Build the container with updated agent runner:

```bash
./container/build.sh
```

Verify the build:
```bash
echo '{}' | docker run -i --entrypoint /bin/echo nanoclaw-agent:latest "Container OK"
```

### 7. Restart Service

Rebuild the main app and restart.

Run from your NanoClaw project root:

```bash
pnpm run build
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
# Linux: systemctl --user restart $(systemd_unit)
```

Wait 3 seconds for service to start, then verify:
```bash
sleep 3
launchctl list | grep "$(. setup/lib/install-slug.sh && launchd_label)"  # macOS
# Linux: systemctl --user status "$(. setup/lib/install-slug.sh && systemd_unit)"
```

### 8. Test Integration

Tell the user to test:
> Send a message to your assistant: `@[YourAssistantName] what's the latest news about AI?`
>
> The assistant should use Parallel Search API to find current information.
>
> Then try: `@[YourAssistantName] can you research the history of artificial intelligence?`
>
> The assistant should ask for permission before using the Task API.

Check logs to verify MCP servers loaded:
```bash
tail -20 logs/nanoclaw.log
```

Look for: `Parallel AI MCP servers configured`

## Troubleshooting

**Container hangs or times out:**
- Check that `type: 'http'` is specified in MCP server config
- Verify API key is correct in .env
- Check container logs: `cat groups/main/logs/container-*.log | tail -50`

**MCP servers not loading:**
- Ensure PARALLEL_API_KEY is in .env
- Verify container-runner.ts includes PARALLEL_API_KEY in allowedVars
- Check agent-runner logs for "Parallel AI MCP servers configured" message

**Task polling not working:**
- Verify scheduled task was created: `pnpm exec tsx scripts/q.ts store/messages.db "SELECT * FROM scheduled_tasks"`
- Check task runs: `tail -f logs/nanoclaw.log | grep "scheduled task"`
- Ensure task prompt includes proper Parallel MCP tool names

## Uninstalling

To remove Parallel AI integration:

1. Remove from .env: `sed -i.bak '/PARALLEL_API_KEY/d' .env`
2. Revert changes to container-runner.ts and agent-runner/src/index.ts
3. Remove Web Research Tools section from groups/main/CLAUDE.md
4. Rebuild: `./container/build.sh && pnpm run build`
5. Restart: `source setup/lib/install-slug.sh && launchctl kickstart -k gui/$(id -u)/$(launchd_label)` (macOS) or `source setup/lib/install-slug.sh && systemctl --user restart $(systemd_unit)` (Linux)
