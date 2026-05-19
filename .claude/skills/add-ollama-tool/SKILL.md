---
name: add-ollama-tool
description: Add Ollama MCP server so the container agent can call local models and optionally manage the Ollama model library.
---

# Add Ollama Integration

This skill adds a stdio-based MCP server that exposes local Ollama models as tools for the container agent. Claude remains the orchestrator but can offload work to local models, and can optionally manage the model library directly.

Core tools (always available):
- `ollama_list_models` — list installed Ollama models with name, size, and family
- `ollama_generate` — send a prompt to a specified model and return the response

Management tools (opt-in via `OLLAMA_ADMIN_TOOLS=true`):
- `ollama_pull_model` — pull (download) a model from the Ollama registry
- `ollama_delete_model` — delete a locally installed model to free disk space
- `ollama_show_model` — show model details: modelfile, parameters, and architecture info
- `ollama_list_running` — list models currently loaded in memory with memory usage and processor type

## Phase 1: Pre-flight

### Check if already applied

Check if `container/agent-runner/src/ollama-mcp-stdio.ts` exists. If it does, skip to Phase 3 (Configure).

### Check prerequisites

Verify Ollama is installed and running on the host:

```bash
ollama list
```

If Ollama is not installed, direct the user to https://ollama.com/download.

If no models are installed, suggest pulling one:

> You need at least one model. I recommend:
>
> ```bash
> ollama pull gemma3:1b    # Small, fast (1GB)
> ollama pull llama3.2     # Good general purpose (2GB)
> ollama pull qwen3-coder:30b  # Best for code tasks (18GB)
> ```

## Phase 2: Apply Code Changes

### Ensure upstream remote

```bash
git remote -v
```

If `upstream` is missing, add it:

```bash
git remote add upstream https://github.com/nanocoai/nanoclaw.git
```

### Merge the skill branch

```bash
git fetch upstream skill/ollama-tool
git merge upstream/skill/ollama-tool
```

This merges in:
- `container/agent-runner/src/ollama-mcp-stdio.ts` (Ollama MCP server)
- `scripts/ollama-watch.sh` (macOS notification watcher)
- Ollama MCP config in `container/agent-runner/src/index.ts` (allowedTools + mcpServers)
- `[OLLAMA]` log surfacing in `src/container-runner.ts`
- `OLLAMA_HOST` in `.env.example`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Copy to per-group agent-runner

Existing groups have a cached copy of the agent-runner source. Copy the new files:

```bash
for dir in data/sessions/*/agent-runner-src; do
  cp container/agent-runner/src/ollama-mcp-stdio.ts "$dir/"
  cp container/agent-runner/src/index.ts "$dir/"
done
```

### Validate code changes

```bash
pnpm run build
./container/build.sh
```

Build must be clean before proceeding.

## Phase 3: Configure

### Enable model management tools (optional)

Ask the user:

> Would you like the agent to be able to **manage Ollama models** (pull, delete, inspect, list running)?
>
> - **Yes** — adds tools to pull new models, delete old ones, show model info, and check what's loaded in memory
> - **No** — the agent can only list installed models and generate responses (you manage models yourself on the host)

If the user wants management tools, add to `.env`:

```bash
OLLAMA_ADMIN_TOOLS=true
```

If they decline (or don't answer), do not add the variable — management tools will be disabled by default.

### Set Ollama host (optional)

By default, the MCP server connects to `http://host.docker.internal:11434` (Docker Desktop) with a fallback to `localhost`. To use a custom Ollama host, add to `.env`:

```bash
OLLAMA_HOST=http://your-ollama-host:11434
```

### Restart the service

Run from your NanoClaw project root:

```bash
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
systemctl --user restart $(systemd_unit)              # Linux
```

## Phase 4: Verify

### Test inference

Tell the user:

> Send a message like: "use ollama to tell me the capital of France"
>
> The agent should use `ollama_list_models` to find available models, then `ollama_generate` to get a response.

### Test model management (if enabled)

If `OLLAMA_ADMIN_TOOLS=true` was set, tell the user:

> Send a message like: "pull the gemma3:1b model" or "which ollama models are currently loaded in memory?"
>
> The agent should call `ollama_pull_model` or `ollama_list_running` respectively.

### Monitor activity (optional)

Run the watcher script for macOS notifications when Ollama is used:

```bash
./scripts/ollama-watch.sh
```

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i ollama
```

Look for:
- `[OLLAMA] >>> Generating` — generation started
- `[OLLAMA] <<< Done` — generation completed
- `[OLLAMA] Pulling model:` — pull in progress (management tools)
- `[OLLAMA] Deleted:` — model removed (management tools)

## Troubleshooting

### Agent says "Ollama is not installed"

The agent is trying to run `ollama` CLI inside the container instead of using the MCP tools. This means:
1. The MCP server wasn't registered — check `container/agent-runner/src/index.ts` has the `ollama` entry in `mcpServers`
2. The per-group source wasn't updated — re-copy files (see Phase 2)
3. The container wasn't rebuilt — run `./container/build.sh`

### "Failed to connect to Ollama"

1. Verify Ollama is running: `ollama list`
2. Check Docker can reach the host: `docker run --rm curlimages/curl curl -s http://host.docker.internal:11434/api/tags`
3. If using a custom host, check `OLLAMA_HOST` in `.env`

### Agent doesn't use Ollama tools

The agent may not know about the tools. Try being explicit: "use the ollama_generate tool with gemma3:1b to answer: ..."

### `ollama_pull_model` times out on large models

Large models (7B+) can take several minutes. The tool uses `stream: false` so it blocks until complete — this is intentional. For very large pulls, use the host CLI directly: `ollama pull <model>`

### Management tools not showing up

Ensure `OLLAMA_ADMIN_TOOLS=true` is set in `.env` and the service was restarted after adding it.
