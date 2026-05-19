---
name: add-atomic-chat-tool
description: Add Atomic Chat MCP server so the container agent can call local models served by the Atomic Chat desktop app via its OpenAI-compatible API.
---

# Add Atomic Chat Integration

This skill adds a stdio-based MCP server that exposes models running in the local [Atomic Chat](https://github.com/AtomicBot-ai/Atomic-Chat) desktop app as tools for the container agent. Claude remains the orchestrator but can offload work to local models served by Atomic Chat on `http://127.0.0.1:1337/v1` (OpenAI-compatible).

Tools exposed:
- `atomic_chat_list_models` — list models currently available in Atomic Chat (`GET /v1/models`)
- `atomic_chat_generate` — send a prompt to a specified model and return the response (`POST /v1/chat/completions`)

Model management (download, delete) is done through the **Atomic Chat desktop UI** — the app is a fork of Jan and manages its own model library.

The skill ships the MCP server source in this folder and copies it into the agent-runner tree at install time, then wires it up with small edits to `index.ts`, `providers/claude.ts`, and `container-runner.ts`. No branch merge — all edits are additive and idempotent.

## Phase 1: Pre-flight

### Check if already applied

Check if `container/agent-runner/src/atomic-chat-mcp-stdio.ts` exists. If it does, skip to Phase 3 (Configure).

### Check prerequisites

Verify Atomic Chat is installed and its local API server is running. On the host:

```bash
curl -s http://127.0.0.1:1337/v1/models | head
```

If the request fails:

1. Install Atomic Chat from the [latest release](https://github.com/AtomicBot-ai/Atomic-Chat/releases) (macOS only for now — `atomic-chat.dmg`).
2. Open the app.
3. Open **Settings → Local API Server** and make sure it's enabled on port `1337`.
4. Go to the **Hub** (or **Models**) tab and download at least one model (e.g. Llama 3.2 3B, Qwen 2.5 Coder 7B).
5. Load the model once by sending any message in Atomic Chat's UI to warm it up.

## Phase 2: Apply Code Changes

### Copy the MCP server source

```bash
cp .claude/skills/add-atomic-chat-tool/atomic-chat-mcp-stdio.ts container/agent-runner/src/atomic-chat-mcp-stdio.ts
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

Add an `atomic_chat` entry alongside `nanoclaw`:

```ts
  const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {
    nanoclaw: {
      command: 'bun',
      args: ['run', mcpServerPath],
      env: {},
    },
    atomic_chat: {
      command: 'bun',
      args: ['run', path.join(__dirname, 'atomic-chat-mcp-stdio.ts')],
      env: {
        ...(process.env.ATOMIC_CHAT_HOST ? { ATOMIC_CHAT_HOST: process.env.ATOMIC_CHAT_HOST } : {}),
        ...(process.env.ATOMIC_CHAT_API_KEY ? { ATOMIC_CHAT_API_KEY: process.env.ATOMIC_CHAT_API_KEY } : {}),
      },
    },
  };
```

### Add the tool glob to the allowlist

Edit `container/agent-runner/src/providers/claude.ts`. Find `'mcp__nanoclaw__*',` in the `TOOL_ALLOWLIST` array and add `'mcp__atomic_chat__*',` on the following line:

```ts
  'mcp__nanoclaw__*',
  'mcp__atomic_chat__*',
];
```

### Forward host env vars into the container

Edit `src/container-runner.ts` in `buildContainerArgs`. Find the `TZ` env line:

```ts
  args.push('-e', `TZ=${TIMEZONE}`);
```

Add ATOMIC_CHAT forwarding right after it:

```ts
  args.push('-e', `TZ=${TIMEZONE}`);

  // Atomic Chat MCP tool: forward host overrides if set (default is host.docker.internal:1337).
  if (process.env.ATOMIC_CHAT_HOST) {
    args.push('-e', `ATOMIC_CHAT_HOST=${process.env.ATOMIC_CHAT_HOST}`);
  }
  if (process.env.ATOMIC_CHAT_API_KEY) {
    args.push('-e', `ATOMIC_CHAT_API_KEY=${process.env.ATOMIC_CHAT_API_KEY}`);
  }
```

### Surface `[ATOMIC]` log lines at info level

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
      if (line.includes('[ATOMIC]')) {
        log.info(line, { container: agentGroup.folder });
      } else {
        log.debug(line, { container: agentGroup.folder });
      }
    }
  });
```

### Add env-var stubs to `.env.example`

Append to `.env.example`:

```bash
# Atomic Chat MCP tool (.claude/skills/add-atomic-chat-tool)
# Override the host where Atomic Chat exposes its OpenAI-compatible API.
# Default: http://host.docker.internal:1337 (with fallback to localhost)
# ATOMIC_CHAT_HOST=http://host.docker.internal:1337

# Optional API key. Leave unset for a local Atomic Chat install — it does not require auth.
# ATOMIC_CHAT_API_KEY=
```

### Validate code changes

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh
```

All three must be clean before proceeding.

## Phase 3: Configure

### Set Atomic Chat host (optional)

By default, the MCP server connects to `http://host.docker.internal:1337` (Docker Desktop) with a fallback to `localhost`. To use a custom host, add to `.env`:

```bash
ATOMIC_CHAT_HOST=http://your-atomic-chat-host:1337
```

### Set API key (optional)

Atomic Chat does **not require authentication** when running locally — leave this unset. Only set it if you've put Atomic Chat behind a reverse proxy that enforces auth:

```bash
ATOMIC_CHAT_API_KEY=sk-...
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

> Send a message like: "use atomic chat to tell me the capital of France"
>
> The agent should use `atomic_chat_list_models` to find available models, then `atomic_chat_generate` to get a response.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i atomic
```

Look for:
- `[ATOMIC] Listing models...` — list request started
- `[ATOMIC] Found N models` — models discovered
- `[ATOMIC] >>> Generating with <model>` — generation started
- `[ATOMIC] <<< Done: <model> | Xs | N tokens | M chars` — generation completed

## Troubleshooting

### Agent says "Atomic Chat is not installed" or tries to run a CLI

The agent is looking for a CLI that doesn't exist instead of using the MCP tools. This means:
1. The MCP server wasn't copied — check `container/agent-runner/src/atomic-chat-mcp-stdio.ts` exists
2. The MCP server wasn't registered — check `container/agent-runner/src/index.ts` has the `atomic_chat` entry in `mcpServers`
3. The allowlist wasn't updated — check `container/agent-runner/src/providers/claude.ts` includes `mcp__atomic_chat__*` in `TOOL_ALLOWLIST`
4. The container wasn't rebuilt — run `./container/build.sh`

### "Failed to connect to Atomic Chat"

1. Verify the host API is reachable: `curl http://127.0.0.1:1337/v1/models`
2. Confirm the Local API Server is enabled in Atomic Chat's settings
3. Check Docker can reach the host: `docker run --rm curlimages/curl curl -s http://host.docker.internal:1337/v1/models`
4. If using a custom host, check `ATOMIC_CHAT_HOST` in `.env`

### `model not found` / 404 on generate

The model ID passed to `atomic_chat_generate` must exactly match one of the IDs returned by `atomic_chat_list_models`. Ask the agent to list models first, then pick one from that list.

### Slow first response

Atomic Chat lazy-loads models into memory on first use. The initial call may take longer while the model warms up. Subsequent calls against the same model are fast.

### Agent doesn't use Atomic Chat tools

The agent may not know about the tools. Try being explicit: "use the atomic_chat_generate tool with llama3.2-3b-instruct to answer: ..."

### Context window or output size issues

Atomic Chat respects each model's native context length. If you hit limits, pass `max_tokens` explicitly when calling `atomic_chat_generate`, or switch to a model with a larger context window in the Atomic Chat UI.
