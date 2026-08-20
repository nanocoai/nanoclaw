---
name: add-atomic-chat-tool
description: Add Atomic Chat MCP server so the container agent can call local models served by the Atomic Chat desktop app via its OpenAI-compatible API. Wired per agent group through the group's container config.
---

# Add Atomic Chat Integration

This skill adds a stdio MCP server that exposes models running in the local [Atomic Chat](https://github.com/AtomicBot-ai/Atomic-Chat) desktop app as tools for a container agent. Claude stays the orchestrator and offloads work to local models served by Atomic Chat on `http://127.0.0.1:1337/v1` (OpenAI-compatible).

Tools exposed:

- `atomic_chat_list_models` — list models currently available in Atomic Chat (`GET /v1/models`)
- `atomic_chat_generate` — send a prompt to a named model and return the response (`POST /v1/chat/completions`)

Model management (download, delete) happens in the **Atomic Chat desktop UI** — the app is a fork of Jan and manages its own model library.

**How it is wired.** The skill copies the MCP server (and its tests) into the trees, then registers it **per agent group** as an MCP server entry in that group's container config — `ncl groups config add-mcp-server`. That is NanoClaw's supported seam for adding an MCP server to an agent: the entry lives in the `container_configs` row, is materialized into `groups/<folder>/container.json` at spawn, and the agent-runner merges it into the provider's server map on boot. Consequences worth knowing before you start:

- Atomic Chat is opt-in per group. A group that should not reach the local models simply has no entry.
- The server's configuration (`ATOMIC_CHAT_HOST`) rides on the entry's `env`, not in `.env` and not in the service unit. NanoClaw never loads `.env` into the host process environment, and the host's contributed-env lane refuses credential-shaped values outright, so an env-var route would be both inert and (for a token) fatal to the group's spawns.
- No source reach-in registers the server, so a trunk update cannot orphan the registration.

**Platform note.** The Atomic Chat *app* is macOS-only today (`atomic-chat.dmg`); the agent side is platform-agnostic. On a Linux or Windows install, run Atomic Chat on a Mac on the LAN and point `ATOMIC_CHAT_HOST` at it (Phase 3).

## Phase 1: Pre-flight

### Check if already applied

If `container/agent-runner/src/atomic-chat-mcp-stdio.ts` exists, the code is already in place — skip to Phase 3 (Configure) to wire it to a group.

### Check prerequisites

Verify Atomic Chat is reachable. On the machine running Atomic Chat:

```bash
curl -s http://127.0.0.1:1337/v1/models | head
```

If that fails:

1. Install Atomic Chat from the [latest release](https://github.com/AtomicBot-ai/Atomic-Chat/releases) — macOS only (`atomic-chat.dmg`). If this NanoClaw install is not on a Mac, install it on a Mac reachable over the LAN and note that machine's IP for Phase 3.
2. Open the app.
3. Open **Settings → Local API Server** and enable it on port `1337`. To serve a LAN client, it must listen on more than loopback — confirm in that panel, then check from the NanoClaw host with `curl -s http://<mac-ip>:1337/v1/models`.
4. Go to the **Hub** (or **Models**) tab and download at least one model (e.g. Llama 3.2 3B, Qwen 2.5 Coder 7B).
5. Send any message in Atomic Chat's UI once to warm the model up.

## Phase 2: Apply Code Changes

### Copy the MCP server and its tests into the trees

The server runs in the container (Bun) tree; the wiring test asserts host-side contracts, so it lands in the host (Node) tree.

```bash
S=.claude/skills/add-atomic-chat-tool
# Container (Bun) tree — the MCP server and its behavior test
cp $S/atomic-chat-mcp-stdio.ts      container/agent-runner/src/atomic-chat-mcp-stdio.ts
cp $S/atomic-chat-mcp-stdio.test.ts container/agent-runner/src/atomic-chat-mcp-stdio.test.ts
# Host (Node) tree — the wiring test
cp $S/atomic-chat-wiring.test.ts    src/atomic-chat-wiring.test.ts
```

That is the whole code change. There is no registration to edit in `container/agent-runner/src/index.ts` and no env forwarding to add in `src/container-runner.ts` — the group's container config carries both (Phase 3).

### Surface `[ATOMIC]` log lines at info level (optional)

Cosmetic: raises the generation progress lines from debug to info so `logs/nanoclaw.log` shows them at the default level. Skip it if you would rather not touch core.

> **Shared block.** This rewrites the driver's container-stderr logger, which other local-model tools (e.g. `add-ollama-tool` for `[OLLAMA]`) also edit to surface their own prefix. Touch only the `[ATOMIC]` branch and leave the rest of the block intact, so the edits coexist and removal restores it cleanly.

In `src/drivers/docker-driver.ts`, inside `DockerHandle.start()`, find the stderr handler:

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
      if (line.includes('[ATOMIC]')) {
        log.info(line, { container: this.name });
      } else {
        log.debug(line, { container: this.name });
      }
      this.#stderrTail.push(line);
      if (this.#stderrTail.length > 10) this.#stderrTail.shift();
    });
```

### Validate code changes

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
# Host tree: the registration contract Phase 3 depends on
pnpm exec vitest run src/atomic-chat-wiring.test.ts
# Container tree: the server's request/response behavior
(cd container/agent-runner && bun test src/atomic-chat-mcp-stdio.test.ts)
```

All four must be clean before proceeding.

Do **not** run `./container/build.sh`. The agent-runner source is bind-mounted read-only into every container at `/app/src`, so a copied `.ts` file is live for the next container start with no image involved; the server's two dependencies (`@modelcontextprotocol/sdk`, `zod`) are already agent-runner deps in the image. What a code change does need is a **fresh container** — `index.ts` builds the server map at boot — which Phase 3's `ncl groups restart` provides anyway.

## Phase 3: Configure

### Pick the agent group

```bash
ncl groups list
```

Atomic Chat is wired per group. Repeat this phase for each group that should reach the local models.

### Register the MCP server on that group

```bash
ncl groups config add-mcp-server \
  --id <agent-group-id> \
  --name atomic_chat \
  --command bun \
  --args '["run","/app/src/atomic-chat-mcp-stdio.ts"]' \
  --env '{"ATOMIC_CHAT_HOST":"http://host.docker.internal:1337"}'
```

- `/app/src/...` is the container-side path of the read-only agent-runner source mount — not a host path.
- `ATOMIC_CHAT_HOST` is where the container reaches Atomic Chat. `http://host.docker.internal:1337` is the app running on this same machine; for a Mac on the LAN use `http://<mac-ip>:1337`. If you omit `--env` entirely, the server defaults to `http://host.docker.internal:1337` and retries `localhost` once if that name does not resolve.
- Re-running the command overwrites the entry, so it is safe to repeat with a corrected host.

Confirm it landed:

```bash
ncl groups config get --id <agent-group-id>
```

### Optional: a token for a fronted Atomic Chat

A local Atomic Chat needs **no authentication** — leave the token out. Only set one if you have put Atomic Chat behind a reverse proxy that enforces auth, and then only a token that proxy issued:

```bash
ncl groups config add-mcp-server \
  --id <agent-group-id> \
  --name atomic_chat \
  --command bun \
  --args '["run","/app/src/atomic-chat-mcp-stdio.ts"]' \
  --env '{"ATOMIC_CHAT_HOST":"http://host.docker.internal:1337","ATOMIC_CHAT_API_KEY":"local-proxy-token"}'
```

Two rules for that value:

- It is stored in the central DB in cleartext, materialized into `groups/<folder>/container.json`, and rendered on the approval card when an agent asks for it. That is acceptable for a token your own proxy minted and you can rotate at will; it is not acceptable for a provider credential. Anything issued by a real provider belongs in the OneCLI vault, never in an MCP entry.
- Never put an issuer-prefixed value here (`sk-…`, `ghp_…`, `xoxb-…`, a JWT). Nothing stops you: unlike the host container-env lanes — which refuse credential-shaped values outright and would deny every spawn for the group — an MCP entry's `env` is not scanned, so such a value is accepted silently and simply sits in the DB in the clear. The placeholder above is deliberately not `sk-...`; the shipped wiring test fails if this document ever documents one again.

### Restart the group so the container picks it up

```bash
ncl groups restart --id <agent-group-id>
```

`index.ts` reads the server map once at boot, so the entry becomes visible to the agent on the next container start. No service restart, no image rebuild.

## Phase 4: Verify

### Test inference

Tell the user:

> Send a message to that agent like: "use atomic chat to tell me the capital of France"
>
> The agent should call `atomic_chat_list_models` to find an available model, then `atomic_chat_generate` to answer.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i atomic
```

Look for:

- `[ATOMIC] Serving Atomic Chat at <host>` — the server started with the host from the entry's env
- `[ATOMIC] Listing models...` — list request started
- `[ATOMIC] Found N models` — models discovered
- `[ATOMIC] >>> Generating with <model>` — generation started
- `[ATOMIC] <<< Done: <model> | Xs | N tokens | M chars` — generation completed

These are info-level only if you applied the optional log step in Phase 2; otherwise they are debug-level.

## Troubleshooting

### Agent says "Atomic Chat is not installed" or tries to run a CLI

The agent is looking for a CLI that does not exist instead of using the MCP tools. Check, in order:

1. The server file is there: `container/agent-runner/src/atomic-chat-mcp-stdio.ts`.
2. The group you are messaging has the entry: `ncl groups config get --id <agent-group-id>` shows `atomic_chat` under `mcp_servers`. Registering on a *different* group is the most common miss — the tool is per group.
3. The group was restarted after the entry was added (`ncl groups restart --id <agent-group-id>`). The server map is built at container boot, so a container that was already running never sees a new entry.

### "Failed to connect to Atomic Chat"

1. Verify the API is up where Atomic Chat runs: `curl http://127.0.0.1:1337/v1/models`.
2. Confirm the Local API Server is enabled in Atomic Chat's settings — and, for a LAN Mac, that it listens on more than loopback.
3. Check the container can reach it: `docker run --rm curlimages/curl curl -s http://host.docker.internal:1337/v1/models`.
4. Check the `ATOMIC_CHAT_HOST` recorded on the entry (`ncl groups config get --id <agent-group-id>`), then re-run `add-mcp-server` with a corrected `--env` and restart the group. Putting `ATOMIC_CHAT_HOST` in `.env` or the service unit does nothing: the MCP server's environment comes from the config entry.

### `model not found` / 404 on generate

The model id passed to `atomic_chat_generate` must match an id from `atomic_chat_list_models` exactly. Ask the agent to list models first, then pick from that list.

### Slow first response

Atomic Chat lazy-loads models into memory on first use. The initial call may take a while as the model warms up; later calls against the same model are fast.

### Agent doesn't use Atomic Chat tools

Be explicit: "use the atomic_chat_generate tool with llama3.2-3b-instruct to answer: ...".

### Context window or output size issues

Atomic Chat respects each model's native context length. If you hit limits, pass `max_tokens` explicitly to `atomic_chat_generate`, or switch to a longer-context model in the Atomic Chat UI.
