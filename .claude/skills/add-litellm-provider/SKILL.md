---
name: add-litellm-provider
description: Route a NanoClaw agent group through a LiteLLM proxy instead of the Anthropic API. LiteLLM translates Anthropic-format requests to 100+ LLM providers (OpenAI, Google, AWS Bedrock, Azure, Groq, Mistral, Cohere, etc.). Same ANTHROPIC_BASE_URL redirect mechanism as /add-ollama-provider. Use when the user wants non-Anthropic models, cheaper providers, or a centralized AI gateway with cost tracking and load balancing.
---

# Add LiteLLM Provider

Routes an agent group through a [LiteLLM](https://github.com/BerriAI/litellm) proxy server instead of the Anthropic API. LiteLLM translates Anthropic-format requests to 100+ LLM providers.

```
Agent container              LiteLLM proxy             LLM providers
Claude Code CLI  ------>     :4000          ------>     OpenAI / Anthropic /
ANTHROPIC_BASE_URL           translates Anthropic       Bedrock / Vertex AI /
http://host.docker.          Messages API format        Groq / Mistral / ...
internal:4000
```

## Prerequisites

1. **LiteLLM proxy is running** on the host. Verify:

   ```bash
   curl -s http://localhost:4000/health | head -5
   ```

   If not running, start it:

   ```bash
   pip install 'litellm[proxy]'
   ANTHROPIC_API_KEY=sk-ant-... litellm --model anthropic/claude-sonnet-4-6 --port 4000
   ```

   Or with a config file for multiple models — create `litellm_config.yaml`:

   ```yaml
   model_list:
     - model_name: claude-sonnet-4-6
       litellm_params:
         model: anthropic/claude-sonnet-4-6
         drop_params: true
     - model_name: gpt-4o
       litellm_params:
         model: openai/gpt-4o
   ```

   Start with: `litellm --config litellm_config.yaml --port 4000`

   See [LiteLLM Proxy docs](https://docs.litellm.ai/docs/proxy/quick_start) for full config.

2. **The agent group already exists** — run `/init-first-agent` first if needed.

## 1. Set ANTHROPIC_BASE_URL in .env

Add the LiteLLM proxy URL to the project `.env` file:

```bash
echo 'ANTHROPIC_BASE_URL=http://host.docker.internal:4000' >> .env
```

This tells the Anthropic SDK inside agent containers to send requests to LiteLLM instead of `api.anthropic.com`. `host.docker.internal` is Docker's hostname that resolves to the host machine from inside a container.

## 2. Enable the claude provider

The claude provider reads `ANTHROPIC_BASE_URL` from `.env` and injects it into containers. Check if it's already imported:

```bash
grep -c "claude" src/providers/index.ts
```

If the count is 0 (only appears in comments), add the import:

```typescript
import './claude.js';
```

at the end of `src/providers/index.ts`.

## 3. Identify the setup

Ask the user (plain text, not AskUserQuestion):

1. **Which agent group?** List available:
   ```bash
   sqlite3 data/v2.db "SELECT folder, name FROM agent_groups;"
   ```
2. **Which model?** E.g. `claude-sonnet-4-6`, `gpt-4o`. List available from LiteLLM:
   ```bash
   curl -s http://localhost:4000/v1/models | grep '"id"'
   ```

Record as `FOLDER` and `MODEL`.

## 4. Set the model

Find the agent group's shared Claude settings:

```bash
AG_ID=$(sqlite3 data/v2.db "SELECT id FROM agent_groups WHERE folder='<FOLDER>';")
SETTINGS=data/v2-sessions/$AG_ID/.claude-shared/settings.json
```

Read the file. Add `"model": "<MODEL>"` to the JSON. If the file already has content, merge the key in — don't overwrite existing keys. If the file doesn't exist, create it:

```json
{
  "model": "claude-sonnet-4-6"
}
```

## 5. Rebuild and restart

```bash
npx tsc
```

Then restart the service:

```bash
# macOS
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist

# Linux
systemctl --user restart nanoclaw

# Or if running manually
pkill -f "tsx src/index.ts"
npx tsx src/index.ts
```

## 6. Verify

Send a message to the agent:

```bash
npx tsx scripts/chat.ts hi
```

The agent should respond. Confirm LiteLLM received the request by checking its terminal output for log lines like:

```
POST /v1/messages 200 OK
```

Also verify the container has the right env:

```bash
CTR=$(docker ps --filter "name=nanoclaw-v2" --format "{{.Names}}" | head -1)
docker exec "$CTR" env | grep ANTHROPIC_BASE_URL
```

Expected: `ANTHROPIC_BASE_URL=http://host.docker.internal:4000`

## Reverting to Claude

1. Remove the `ANTHROPIC_BASE_URL` line from `.env`
2. Remove `"model"` from the shared settings file
3. Remove `import './claude.js';` from `src/providers/index.ts` (if it wasn't there before)
4. Restart the service

## Troubleshooting

**Agent hangs, no response:** LiteLLM proxy may be unreachable from inside the container. Verify: `docker exec "$CTR" curl -s http://host.docker.internal:4000/health`

**401 from LiteLLM:** The proxy requires an API key for the backing provider. Set it when starting litellm: `ANTHROPIC_API_KEY=sk-ant-... litellm --config ...`

**"model not found":** The model name in settings.json must match what LiteLLM has configured. Run `curl -s http://localhost:4000/v1/models` to check.

**Responses claim to be Claude:** The backing model may identify differently. Add a note to `groups/<FOLDER>/CLAUDE.local.md`.
