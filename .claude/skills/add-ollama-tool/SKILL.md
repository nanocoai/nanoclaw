---
name: add-ollama-tool
description: Add Ollama MCP server so the container agent can call local models and optionally manage the Ollama model library.
---

# Add Ollama Integration

This skill adds a stdio-based MCP server that exposes local [Ollama](https://ollama.com) models as tools for the container agent. Claude remains the orchestrator but can offload work to local models served by the Ollama daemon on the host, and can optionally manage the model library directly. Ollama runs locally and is keyless — there are no credentials to thread; the only configuration is the daemon's base URL.

Core tools (always available):
- `ollama_list_models` — list installed models with name, size, and family (`GET /api/tags`)
- `ollama_generate` — send a prompt to a specified model and return the response (`POST /api/generate`)

Management tools (opt-in via `OLLAMA_ADMIN_TOOLS=true`):
- `ollama_pull_model` — pull (download) a model from the Ollama registry (`POST /api/pull`)
- `ollama_delete_model` — delete a locally installed model to free disk space (`DELETE /api/delete`)
- `ollama_show_model` — show model details: modelfile, parameters, and architecture info (`POST /api/show`)
- `ollama_list_running` — list models currently loaded in memory with memory usage and processor type (`GET /api/ps`)

The skill ships the MCP server source (and its tests) in this folder and copies them into the agent-runner tree at install time, then registers the server in `index.ts` and forwards host env vars in `container-runner.ts`. Registering the server is enough to expose its tools — the agent's allow-pattern (`mcp__ollama__*`) is derived from the registered server name.

## Phase 1: Pre-flight

### Check if already applied

Check if `container/agent-runner/src/ollama-mcp-stdio.ts` exists. If it does, skip to Phase 3 (Configure).

### Check prerequisites

Verify Ollama is installed and its daemon is reachable. On the host:

```bash
curl -s http://127.0.0.1:11434/api/tags | head
```

If the request fails:

1. Install Ollama from https://ollama.com/download.
2. Start it (the desktop app runs the daemon, or run `ollama serve`).
3. Confirm the daemon answers: `curl -s http://127.0.0.1:11434/api/tags`.

If no models are installed, suggest pulling one:

> You need at least one model. For example:
>
> ```bash
> ollama pull gemma3:1b        # Small, fast (~1GB)
> ollama pull llama3.2         # Good general purpose (~2GB)
> ollama pull qwen3-coder:30b  # Best for code tasks (~18GB)
> ```

## Phase 2: Apply Code Changes

### Copy the skill's source and tests into both trees

This skill reaches into both the container (Bun) tree and the host (Node) tree, so its
files go into both, alongside the integration points they cover.

```bash
S=.claude/skills/add-ollama-tool
# Container (Bun) tree — the MCP server and the registration wiring test
cp $S/ollama-mcp-stdio.ts       container/agent-runner/src/ollama-mcp-stdio.ts
cp $S/ollama-registration.test.ts container/agent-runner/src/ollama-registration.test.ts
# Host (Node) tree — the env-forwarding helper and the wiring test
cp $S/ollama-env.ts             src/ollama-env.ts
cp $S/ollama-wiring.test.ts     src/ollama-wiring.test.ts
```

### Register the MCP server in the agent-runner

Edit `container/agent-runner/src/index.ts`. Find the `mcpServers` object that currently looks like this:

```ts
  const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {
    nanoclaw: {
      command: 'bun',
      args: ['run', mcpServerPath],
      env: {},
    },
  };
```

Add an `ollama` entry alongside `nanoclaw`:

```ts
  const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {
    nanoclaw: {
      command: 'bun',
      args: ['run', mcpServerPath],
      env: {},
    },
    ollama: {
      command: 'bun',
      args: ['run', path.join(__dirname, 'ollama-mcp-stdio.ts')],
      env: {
        ...(process.env.OLLAMA_HOST ? { OLLAMA_HOST: process.env.OLLAMA_HOST } : {}),
        ...(process.env.OLLAMA_ADMIN_TOOLS ? { OLLAMA_ADMIN_TOOLS: process.env.OLLAMA_ADMIN_TOOLS } : {}),
      },
    },
  };
```

`ollama-registration.test.ts` asserts this entry is present and points at the server module — the tool only appears to the agent if it is registered here.

### Forward host env vars into the container

The container receives `TZ` and OneCLI networking vars by default; any other host env
var the MCP subprocess needs must be forwarded explicitly. The forwarding logic lives in
the copied `src/ollama-env.ts` (`ollamaEnvArgs()`) — `OLLAMA_HOST` (the daemon base URL)
and `OLLAMA_ADMIN_TOOLS` (the library-management opt-in flag). Both are configuration, not
credentials, so they are passed through plainly; Ollama itself is local and keyless.

Import it in `src/container-runner.ts` (alongside the other local imports):

```ts
import { ollamaEnvArgs } from './ollama-env.js';
```

Then, in `buildContainerArgs`, find the `TZ` env line and add the call right after it:

```ts
  args.push('-e', `TZ=${TIMEZONE}`);
  args.push(...ollamaEnvArgs());
```

`ollama-wiring.test.ts` asserts this `args.push(...ollamaEnvArgs())` call exists inside `buildContainerArgs`.

### Surface `[OLLAMA]` log lines at info level

> **Shared block.** This rewrites the `container.stderr` logger, which other local-model tools (e.g. `add-atomic-chat-tool` for `[ATOMIC]`) also edit to surface their own prefix. Touch only the `[OLLAMA]` branch and leave the rest of the block intact, so the edits coexist and removal restores it cleanly.

In the same file, find the stderr logger:

```ts
  container.stderr?.on('data', (data) => {
    for (const line of data.toString().trim().split('\n')) {
      if (line) log.debug(line, { container: agentGroup.folder });
    }
  });
```

Replace it with:

```ts
  container.stderr?.on('data', (data) => {
    for (const line of data.toString().trim().split('\n')) {
      if (!line) continue;
      if (line.includes('[OLLAMA]')) {
        log.info(line, { container: agentGroup.folder });
      } else {
        log.debug(line, { container: agentGroup.folder });
      }
    }
  });
```

If `add-atomic-chat-tool` (or another local-model tool) has already turned this into a
multi-branch block, just add an `else if (line.includes('[OLLAMA]'))` branch instead of
replacing it.

### Add env-var stubs to `.env.example`

Append to `.env.example`:

```bash
# Ollama MCP tool (.claude/skills/add-ollama-tool)
# Override the host where the Ollama daemon listens.
# Default: http://host.docker.internal:11434 (with fallback to localhost)
# OLLAMA_HOST=http://host.docker.internal:11434

# Opt in to library-management tools (pull, delete, show, list-running).
# Leave unset to expose only list + generate.
# OLLAMA_ADMIN_TOOLS=true
```

### Validate code changes

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
# Host tree: buildContainerArgs wiring
pnpm exec vitest run src/ollama-wiring.test.ts
# Container tree: index.ts registration
(cd container/agent-runner && bun test src/ollama-registration.test.ts)
./container/build.sh
```

All must be clean before proceeding. The wiring and registration tests confirm the two
integration points — the `buildContainerArgs` call and the `index.ts` registration — are
actually in place; a failure means one drifted. (The MCP server's own request/response
behavior against the Ollama daemon is the author's build-time concern, not part of these
tests — verify it manually in Phase 4.)

## Phase 3: Configure

### Enable library-management tools (optional)

Ask the user:

> Would you like the agent to be able to **manage Ollama models** (pull, delete, inspect, list running)?
>
> - **Yes** — adds tools to pull new models, delete old ones, show model info, and check what's loaded in memory
> - **No** — the agent can only list installed models and generate responses (you manage models yourself on the host)

If the user wants management tools, add to `.env`:

```bash
OLLAMA_ADMIN_TOOLS=true
```

If they decline (or don't answer), leave the variable unset — only list + generate are exposed.

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
# Linux: systemctl --user restart $(systemd_unit)
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

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i ollama
```

Look for:
- `[OLLAMA] Listing models...` — list request started
- `[OLLAMA] Found N models` — models discovered
- `[OLLAMA] >>> Generating with <model>` — generation started
- `[OLLAMA] <<< Done: <model> | Xs | N tokens | M chars` — generation completed
- `[OLLAMA] Pulling model:` — pull in progress (management tools)
- `[OLLAMA] Deleted:` — model removed (management tools)

## Troubleshooting

### Agent says "Ollama is not installed" or tries to run a CLI

The agent is looking for an `ollama` CLI inside the container instead of using the MCP tools. This means:
1. The MCP server wasn't copied — check `container/agent-runner/src/ollama-mcp-stdio.ts` exists
2. The MCP server wasn't registered — check `container/agent-runner/src/index.ts` has the `ollama` entry in `mcpServers` (the allow-pattern is derived from this, so registration is the only thing to check)
3. The container wasn't rebuilt — run `./container/build.sh`

### "Failed to connect to Ollama"

1. Verify the daemon is reachable: `curl http://127.0.0.1:11434/api/tags`
2. Confirm Ollama is running (`ollama list` on the host)
3. Check Docker can reach the host: `docker run --rm curlimages/curl curl -s http://host.docker.internal:11434/api/tags`
4. If using a custom host, check `OLLAMA_HOST` in `.env`

### `model not found` / 404 on generate

The model name passed to `ollama_generate` must exactly match one of the names returned by `ollama_list_models` (including any `:tag` suffix, e.g. `gemma3:1b`). Ask the agent to list models first, then pick one from that list.

### `ollama_pull_model` times out on large models

Large models (7B+) can take several minutes. The tool uses `stream: false` so it blocks until the pull completes — this is intentional. For very large pulls, use the host CLI directly: `ollama pull <model>`.

### Management tools not showing up

Ensure `OLLAMA_ADMIN_TOOLS=true` is set in `.env` and the service was restarted after adding it. The management tools are only registered when that flag is present in the container's environment.

### Slow first response

Ollama lazy-loads models into memory on first use. The initial call may take longer while the model warms up. Subsequent calls against the same model are fast.

### Agent doesn't use Ollama tools

The agent may not know about the tools. Try being explicit: "use the ollama_generate tool with gemma3:1b to answer: ..."
