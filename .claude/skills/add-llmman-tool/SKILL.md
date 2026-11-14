---
name: add-llmman-tool
description: Add llmman MCP server so the container agent can call local models served by llmman and optionally manage the llmman model library.
---

# Add llmman Integration

This skill adds a stdio-based MCP server that exposes local [llmman](https://github.com/llmmanorg/llmman) models as tools for the container agent. Claude remains the orchestrator but can offload work to local models served by the llmman daemon (`llmman serve`) on the host, and can optionally manage the model library directly. llmman answers Ollama-compatible `/api/*` routes on one endpoint (`127.0.0.1:17434` by default), so the tool talks to it the way the Ollama tool talks to Ollama. The daemon is keyless unless you set `LLMMAN_API_KEYS`; the tool sends `LLMMAN_API_KEY` as a Bearer token when you give it one.

Core tools (always available):
- `llmman_list_models` — list stored models with name, size, family, parameters and quantization (`GET /api/tags`)
- `llmman_generate` — send a prompt to a specified model and return the response (`POST /api/generate`). Without `LLMMAN_ADMIN_TOOLS` it refuses a model that is not already stored (see Troubleshooting)

Management tools (opt-in via `LLMMAN_ADMIN_TOOLS=true`):
- `llmman_pull_model` — pull (download) a model from an OCI registry or Hugging Face (`POST /api/pull`)
- `llmman_delete_model` — delete a stored model to free disk space (`DELETE /api/delete`)
- `llmman_show_model` — show model details: format, family, quantization, capabilities and chat template (`POST /api/show`)
- `llmman_list_running` — list models currently loaded, with size, serving engine, context window and unload time (`GET /api/ps`)

The skill ships the MCP server source (and its tests) in this folder and copies them into the agent-runner tree at install time, then registers the server in `index.ts` and forwards host env vars in `container-runner.ts`. Registering the server is enough to expose its tools — the agent's allow-pattern (`mcp__llmman__*`) is derived from the registered server name.

This skill can sit next to `add-ollama-tool` and `add-atomic-chat-tool`: the files, the `llmman` server name, the `llmman_*` tool names, the `LLMMAN_*` env vars and the `[LLMMAN]` log prefix are all its own.

## Phase 1: Pre-flight

### Check if already applied

Check if `container/agent-runner/src/llmman-mcp-stdio.ts` exists. If it does, skip to Phase 3 (Configure).

### Check prerequisites

Verify llmman is installed and its daemon is reachable. On the host:

```bash
curl -s http://127.0.0.1:17434/api/tags | head
```

If the request fails:

1. Install llmman: `curl -fsSL https://llmmanorg.github.io/install.sh | sh` (or `brew install llmmanorg/tap/llmman`).
2. Start the daemon: `llmman serve` (`llmman run <model>` and `llmman launch` also start one in the background).
3. Confirm the daemon answers: `curl -s http://127.0.0.1:17434/api/tags`.

If the daemon needs an API key (`LLMMAN_API_KEYS` is set), add `-H "Authorization: Bearer <key>"` to the `curl`.

If no models are installed, suggest pulling one:

> You need at least one model. For example:
>
> ```bash
> llmman pull hf.co/unsloth/Qwen3.5-0.8B-GGUF  # Small, fast (<1GB)
> llmman pull qwen3.8                           # General purpose
> ```

### Make the daemon reachable from the container

The tool reaches the daemon at `host.docker.internal`. `llmman serve` binds `127.0.0.1` by default:

- **Docker Desktop (macOS, Windows):** the default bind is reachable from a container; nothing to change.
- **Linux:** a container reaches the host through the Docker bridge, not host loopback, so the daemon must listen on an address the bridge can reach (for example `LLMMAN_HOST=0.0.0.0:17434 llmman serve`, or the bridge address, often `172.17.0.1`). llmman refuses to start on an address the network can reach unless `LLMMAN_API_KEYS` is set (or `LLMMAN_AUTH=off`). Set a key and give the same key to the tool in Phase 3.

## Phase 2: Apply Code Changes

### Copy the skill's source and tests into both trees

This skill reaches into both the container (Bun) tree and the host (Node) tree, so its
files go into both, alongside the integration points they cover.

```bash
S=.claude/skills/add-llmman-tool
# Container (Bun) tree — the MCP server and the registration wiring test
cp $S/llmman-mcp-stdio.ts         container/agent-runner/src/llmman-mcp-stdio.ts
cp $S/llmman-registration.test.ts container/agent-runner/src/llmman-registration.test.ts
# Host (Node) tree — the env-forwarding helper and the wiring test
cp $S/llmman-env.ts               src/llmman-env.ts
cp $S/llmman-wiring.test.ts       src/llmman-wiring.test.ts
```

### Register the MCP server in the agent-runner

Edit `container/agent-runner/src/index.ts`. Find the `mcpServers` object that currently looks like this:

```ts
  const mcpServers: Record<string, McpServerConfig> = {
    nanoclaw: {
      command: 'bun',
      args: ['run', mcpServerPath],
      env: {},
    },
  };
```

Add an `llmman` entry alongside `nanoclaw` (and alongside any other local-model tool entries):

```ts
  const mcpServers: Record<string, McpServerConfig> = {
    nanoclaw: {
      command: 'bun',
      args: ['run', mcpServerPath],
      env: {},
    },
    llmman: {
      command: 'bun',
      args: ['run', path.join(__dirname, 'llmman-mcp-stdio.ts')],
      env: {
        ...(process.env.LLMMAN_HOST ? { LLMMAN_HOST: process.env.LLMMAN_HOST } : {}),
        ...(process.env.LLMMAN_API_KEY ? { LLMMAN_API_KEY: process.env.LLMMAN_API_KEY } : {}),
        ...(process.env.LLMMAN_ADMIN_TOOLS ? { LLMMAN_ADMIN_TOOLS: process.env.LLMMAN_ADMIN_TOOLS } : {}),
      },
    },
  };
```

`llmman-registration.test.ts` asserts this entry is present and points at the server module — the tool only appears to the agent if it is registered here.

### Forward host env vars into the container

The container receives `TZ` and gateway networking vars by default; any other host env
var the MCP subprocess needs must be forwarded explicitly. The forwarding logic lives in
the copied `src/llmman-env.ts` (`llmmanEnv()`) — `LLMMAN_HOST` (the daemon address),
`LLMMAN_API_KEY` (the Bearer key, only for a daemon that has `LLMMAN_API_KEYS`) and
`LLMMAN_ADMIN_TOOLS` (the library-management opt-in flag). It reads the host process
environment first and the project `.env` second.

`LLMMAN_API_KEY` is credential-NAMED, so the helper is spread into the contributed env lane
(`contributedEnv`), not the composed `env` literal: the composed lane's key-name check would
refuse it and deny the spawn, while the contributed lane exempts the name and still refuses
credential-shaped values. (`add-atomic-chat-tool` uses the same lane for `ATOMIC_CHAT_API_KEY`.)

Import it in `src/container-runner.ts` (alongside the other local imports):

```ts
import { llmmanEnv } from './llmman-env.js';
```

Then, in `composeSessionSpec`, find the `contributedEnv` literal and spread the helper at the end (after any other local-model tool's spread):

```ts
  const contributedEnv: Record<string, string> = {
    ...(contribution.env ?? {}),
    ...(gateway.env ?? {}),
    ...llmmanEnv(),
  };
```

`llmman-wiring.test.ts` asserts this `...llmmanEnv()` spread exists inside the `contributedEnv` literal in `composeSessionSpec`, and checks the helper's own behavior against a temp `.env`.

### Surface `[LLMMAN]` log lines at info level

> **Shared block.** This rewrites the driver's container-stderr logger, which other local-model tools (e.g. `add-ollama-tool` for `[OLLAMA]`, `add-atomic-chat-tool` for `[ATOMIC]`) also edit to surface their own prefix. Touch only the `[LLMMAN]` branch and leave the rest of the block intact, so the edits coexist and removal restores it cleanly.

Container stderr lands in the Docker driver: in `src/drivers/docker-driver.ts`, inside `DockerHandle.start()`, find the stderr handler:

```ts
    proc.onStderr((line) => {
      log.debug(line, { container: this.name });
      this.#stderrTail.push(line);
      if (this.#stderrTail.length > 10) this.#stderrTail.shift();
    });
```

Replace the `log.debug` line with a prefix branch (leave the stderr-tail lines intact — they feed the non-zero-exit warning):

```ts
    proc.onStderr((line) => {
      if (line.includes('[LLMMAN]')) {
        log.info(line, { container: this.name });
      } else {
        log.debug(line, { container: this.name });
      }
      this.#stderrTail.push(line);
      if (this.#stderrTail.length > 10) this.#stderrTail.shift();
    });
```

If `add-ollama-tool`, `add-atomic-chat-tool` (or another local-model tool) has already turned this into a
multi-branch block, just add an `else if (line.includes('[LLMMAN]'))` branch instead of
replacing it.

### Add env-var stubs to `.env.example`

Append to `.env.example`:

```bash
# llmman MCP tool (.claude/skills/add-llmman-tool)
# Where the llmman daemon listens, in llmman's own [scheme://][host][:port] spelling.
# A loopback or wildcard host (127.0.0.1, 0.0.0.0) is read as "the Docker host".
# Default: http://host.docker.internal:17434 (with fallback to localhost)
# LLMMAN_HOST=http://host.docker.internal:17434

# Only when the daemon was started with LLMMAN_API_KEYS: one of its keys, sent as
# `Authorization: Bearer`. Never put the daemon's whole LLMMAN_API_KEYS list here.
# LLMMAN_API_KEY=

# Opt in to library-management tools (pull, delete, show, list-running).
# Leave unset to expose only list + generate.
# LLMMAN_ADMIN_TOOLS=true
```

### Validate code changes

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
# Host tree: composeSessionSpec wiring and the env helper
pnpm exec vitest run src/llmman-wiring.test.ts
# Container tree: index.ts registration
(cd container/agent-runner && bun test src/llmman-registration.test.ts)
./container/build.sh
```

All must be clean before proceeding. The wiring and registration tests confirm the two
integration points — the `composeSessionSpec` spread and the `index.ts` registration — are
actually in place; a failure means one drifted. (The MCP server's own request/response
behavior against the llmman daemon is the author's build-time concern, not part of these
tests — verify it manually in Phase 4.)

## Phase 3: Configure

### Enable library-management tools (optional)

Ask the user:

> Would you like the agent to be able to **manage llmman models** (pull, delete, inspect, list running)?
>
> - **Yes** — adds tools to pull new models, delete old ones, show model info, and check what's loaded
> - **No** — the agent can only list stored models and generate responses (you manage models yourself on the host)

If the user wants management tools, add to `.env`:

```bash
LLMMAN_ADMIN_TOOLS=true
```

If they decline (or don't answer), leave the variable unset — only list + generate are exposed.

### Set the llmman host (optional)

By default, the MCP server connects to `http://host.docker.internal:17434` (Docker Desktop) with a fallback to `localhost`. To use a custom daemon address, add to `.env`:

```bash
LLMMAN_HOST=http://your-llmman-host:17434
```

`LLMMAN_HOST` is read the way llmman reads it: `[scheme://][host][:port]`, with the port defaulting to 17434 when you give no scheme. Inside the container a loopback or wildcard host (`127.0.0.1`, `localhost`, `0.0.0.0`) is mapped to `host.docker.internal`.

### Set the API key (only if the daemon requires one)

llmman is open on a loopback bind and requires a key on every route once `LLMMAN_API_KEYS` is set. If it is set (as it must be for the Linux bind in Phase 1), give the tool one of those keys:

```bash
LLMMAN_API_KEY=<one key from the daemon's LLMMAN_API_KEYS>
```

Use a key made for this install — for example `openssl rand -hex 24` — and add it to the daemon's list. The key reaches the agent's container environment, and a key that opens the daemon also lets the caller spend any hosted-provider keys the daemon holds (see llmman's API docs, "Authentication"); keep such keys off this daemon. A key shaped like an issuer credential (`sk-…`) is refused when the container is composed, so pick another form.

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

> Send a message like: "use llmman to tell me the capital of France"
>
> The agent should use `llmman_list_models` to find available models, then `llmman_generate` to get a response.

### Test model management (if enabled)

If `LLMMAN_ADMIN_TOOLS=true` was set, tell the user:

> Send a message like: "pull the hf.co/unsloth/Qwen3.5-0.8B-GGUF model" or "which llmman models are currently loaded?"
>
> The agent should call `llmman_pull_model` or `llmman_list_running` respectively.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i llmman
```

Look for:
- `[LLMMAN] Listing models...` — list request started
- `[LLMMAN] Found N models` — models discovered
- `[LLMMAN] >>> Generating with <model>` — generation started
- `[LLMMAN] <<< Done: <model> | Xs | N tokens | M chars` — generation completed
- `[LLMMAN] Pulling model:` — pull in progress (management tools)
- `[LLMMAN] Deleted:` — model removed (management tools)

## Troubleshooting

### Agent says "llmman is not installed" or tries to run a CLI

The agent is looking for an `llmman` CLI inside the container instead of using the MCP tools. This means:
1. The MCP server wasn't copied — check `container/agent-runner/src/llmman-mcp-stdio.ts` exists
2. The MCP server wasn't registered — check `container/agent-runner/src/index.ts` has the `llmman` entry in `mcpServers` (the allow-pattern is derived from this, so registration is the only thing to check)
3. The container wasn't rebuilt — run `./container/build.sh`

### "Failed to connect to llmman"

1. Verify the daemon is reachable on the host: `curl http://127.0.0.1:17434/api/tags`
2. Confirm the daemon is running on the host (start it with `llmman serve` if it is not)
3. Check Docker can reach the host: `docker run --rm curlimages/curl curl -s http://host.docker.internal:17434/api/tags`. On Linux this fails while the daemon is bound to `127.0.0.1` — rebind it as described in Phase 1.
4. If using a custom host, check `LLMMAN_HOST` in `.env`

### 401 / "the daemon requires an API key"

The daemon has `LLMMAN_API_KEYS` set. Put one of those keys in `LLMMAN_API_KEY` in `.env` and restart the service. If the spawn itself is refused with "credential value in contributed env 'LLMMAN_API_KEY'", the key looks like a provider credential — generate a different one.

### `model not found` / 404 on generate

The model name passed to `llmman_generate` must be one that llmman already stores — a name from `llmman_list_models` (a short name that resolves to a stored model also works). llmman itself pulls a model it does not have from a registry on demand, so without `LLMMAN_ADMIN_TOOLS=true` the tool refuses an unstored name up front ("not stored in llmman, and this agent may not download models"). Ask the agent to list models first, then pick one from that list, or pull the model on the host with `llmman pull <model>`.

### `llmman_pull_model` times out on large models

Large models can take several minutes. The tool reads llmman's progress stream to the end and reports the final result, so it blocks until the pull completes — this is intentional. For very large pulls, use the host CLI directly: `llmman pull <model>`.

### Management tools not showing up

Ensure `LLMMAN_ADMIN_TOOLS=true` is set in `.env` and the service was restarted after adding it. The management tools are only registered when that flag is present in the container's environment.

### Slow first response

llmman loads models on demand and unloads them after the idle `keep_alive` (five minutes by default). The first call after a model has unloaded takes longer while it loads; calls while it is loaded are fast.

### Agent doesn't use llmman tools

The agent may not know about the tools. Try being explicit: "use the llmman_generate tool with qwen3.8 to answer: ..."
