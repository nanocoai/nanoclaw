---
name: add-ollama-tool
description: Add Ollama MCP server so the container agent can call local models and optionally manage the Ollama model library.
---

# Add Ollama Tool

Install a stdio MCP server that exposes the host's [Ollama](https://ollama.com)
daemon as tools, and register it for each selected agent group. The agent's own
provider stays the orchestrator; it offloads work to local models and can
optionally manage the model library.

Ollama is local and keyless — there are no credentials to thread. The only
configuration is the daemon's base URL and one opt-in flag, and both travel in
the group's MCP entry, so two groups on the same install can point at different
daemons, or one group can have the tools and another not.

Core tools (always exposed):

- `mcp__ollama__ollama_list_models` — installed models with name, size, family (`GET /api/tags`)
- `mcp__ollama__ollama_generate` — prompt a named model and return the response (`POST /api/generate`)

Management tools (opt-in, `--admin-tools`):

- `mcp__ollama__ollama_pull_model` — pull a model from the Ollama registry (`POST /api/pull`)
- `mcp__ollama__ollama_delete_model` — delete a local model to free disk (`DELETE /api/delete`)
- `mcp__ollama__ollama_show_model` — modelfile, parameters, architecture (`POST /api/show`)
- `mcp__ollama__ollama_list_running` — models warm in memory, with memory use and CPU/GPU split (`GET /api/ps`)

The skill copies one file into `container/agent-runner/src/` and adds one
per-group MCP entry through `ncl`. It edits no trunk source: the agent-runner
tree is bind-mounted read-only into every container at `/app/src`, so the copied
file is already at a stable container path and needs no image rebuild, and
registration is runtime state in the `container_configs` table.

## Phase 1: Pre-flight

### Check if already applied

```bash
ls container/agent-runner/src/ollama-mcp-stdio.ts 2>/dev/null
ncl groups list
ncl groups config get --id <group-id>   # look for an `ollama` MCP server
```

The file being present means Phase 2 is done; an `ollama` entry in a group's
config means Phase 3 is done for that group. Both steps are idempotent — a
second `add-mcp-server` with the same name overwrites the entry.

### Check the daemon is reachable from the host

```bash
curl -s http://127.0.0.1:11434/api/tags | head
```

If that fails: install Ollama from https://ollama.com/download, start it (the
desktop app runs the daemon, or `ollama serve`), and re-run the curl. If it
answers with an empty `models` list, suggest pulling one:

> You need at least one model. For example:
>
> ```bash
> ollama pull gemma3:1b        # Small, fast (~1GB)
> ollama pull llama3.2         # Good general purpose (~2GB)
> ollama pull qwen3-coder:30b  # Best for code tasks (~18GB)
> ```

### Check the container can reach the host at all

`host.docker.internal` is the route this tool uses. Normally the session has it:
on Linux the spawn adds `--add-host=host.docker.internal:host-gateway`, and
Docker Desktop provides the name itself (`dockerNetworkArgs`,
`src/drivers/index.ts`). **Egress lockdown replaces both.** With
`NANOCLAW_EGRESS_LOCKDOWN=true` the session instead joins a Docker `--internal`
network — no host route — on which `host.docker.internal` is an alias for the
OneCLI gateway container (`src/egress-lockdown.ts`). The name still resolves, so
nothing errors early: the connection simply goes to the gateway and the daemon
is unreachable. Check before promising anything:

```bash
grep -n '^NANOCLAW_EGRESS_LOCKDOWN' .env 2>/dev/null || echo 'lockdown not set (default off)'
```

If it is `true`, say so plainly: a host-local Ollama daemon is **not reachable**
from a locked-down session. The options are to expose the daemon at an address
that is routable from the egress network and pass that as `--host`, or to leave
lockdown off for the groups that need Ollama. Do not proceed on the assumption
that `host.docker.internal` works.

## Phase 2: Install the MCP server

```bash
S=.claude/skills/add-ollama-tool
cp $S/ollama-mcp-stdio.ts      container/agent-runner/src/ollama-mcp-stdio.ts
cp $S/ollama-mcp-stdio.test.ts container/agent-runner/src/ollama-mcp-stdio.test.ts
```

Validate — no image rebuild is involved, `container/agent-runner/src` is mounted
read-only into every session at `/app/src`:

```bash
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
(cd container/agent-runner && bun test src/ollama-mcp-stdio.test.ts)
pnpm exec vitest run --config vitest.skills.config.ts .claude/skills/add-ollama-tool/ollama-install.test.ts
```

The behavior test drives the real tools over an in-memory MCP transport against
a local stub daemon, so it covers the configuration seam and all six handlers.
The install test checks the shape this skill depends on: the documented
container path still resolves inside the trunk mount, and
`ncl groups config add-mcp-server` still accepts the payload Phase 3 sends.

## Phase 3: Register it per group

### Ask about the management tools

> Should the agent be able to **manage Ollama models** — pull, delete, inspect,
> and list what is loaded?
>
> - **Yes** — adds `ollama_pull_model`, `ollama_delete_model`,
>   `ollama_show_model`, `ollama_list_running`. Pull and delete change the model
>   library on your host.
> - **No** — the agent can only list installed models and generate. You manage
>   the library yourself.

Answering yes adds `--admin-tools` to the args below; answering no (or not
answering) omits it.

### Register

`config add-mcp-server` and `groups restart` are approval-gated. Run from
inside a container they return `approval-pending` immediately; that is not an
error — wait for the approval and the follow-up system message.

For each selected `<group-id>`:

```bash
ncl groups config add-mcp-server \
  --id <group-id> \
  --name ollama \
  --command bun \
  --args '["run","/app/src/ollama-mcp-stdio.ts","--host","http://host.docker.internal:11434","--admin-tools"]'
```

- `--host` is the daemon base URL **as seen from inside the container**.
  `http://host.docker.internal:11434` is the default Docker route to the host;
  use a real hostname or IP for a daemon on another machine, and see the
  lockdown note in Phase 1.
- Drop `--admin-tools` if the user declined the management tools.
- The configuration deliberately rides in the args rather than in host
  environment variables: `.env` is never loaded into the host process
  environment (`src/env.ts`), and nothing forwards it into a container, so an
  `OLLAMA_HOST=` line in `.env` would have no effect anywhere.

Restart each group so the new server is picked up:

```bash
ncl groups restart \
  --id <group-id> \
  --message "Ollama tools are installed. Call ollama_list_models and report what came back."
```

## Phase 4: Verify

Confirm the stored config, then the agent's answer:

```bash
ncl groups config get --id <group-id>
```

The `ollama` entry should show `command: bun` and the args you passed, including
the `--host` you chose. Then check the restart message's reply: it must name
models the daemon actually has. Tell the user:

> Send a message like "use ollama to tell me the capital of France".
>
> The agent should call `ollama_list_models` to see what is installed, then
> `ollama_generate` with one of those names.

If the management tools were enabled:

> Send "which ollama models are currently loaded in memory?" — the agent should
> call `ollama_list_running`.

The server logs each call to stderr with an `[OLLAMA]` prefix. Where that lands
is the provider's business, not the host's: Claude Code captures MCP server
stderr into its own MCP log rather than forwarding it to the container's stderr,
so do not expect `[OLLAMA]` lines in `logs/nanoclaw.log`. Verify through the
tool results, which are in the agent transcript.

## Troubleshooting

### The agent says Ollama is not installed, or tries to run an `ollama` CLI

It has no `ollama` tools, so it fell back to guessing. In order:

1. `ls container/agent-runner/src/ollama-mcp-stdio.ts` — Phase 2 applied?
2. `ncl groups config get --id <group-id>` — is there an `ollama` entry for
   *this* group? Registration is per group; another group having it is not enough.
3. Was the group restarted after registration? MCP servers are read at spawn.

There is no image rebuild step to have missed — the file is mounted, not baked.

### "Failed to connect to Ollama at &lt;url&gt;"

The message names the URL the server actually used; compare it with the
`--host` in `ncl groups config get`.

1. Daemon up on the host: `curl -s http://127.0.0.1:11434/api/tags`
2. Reachable from a container **on the session's own network**. A bare
   `docker run … curl http://host.docker.internal:…` lands on the default
   bridge, which is not the network the agent uses, so its answer is noise in
   both directions: under Docker Desktop it resolves and passes even when the
   session is locked down, and on Linux Docker it fails to resolve even when the
   session's route is fine. Reproduce the session's own topology instead:

   ```bash
   # Which network is the session on?
   docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}{{.HostConfig.ExtraHosts}}' <container-name>

   # Default (no lockdown): same host-gateway alias the agent gets
   docker run --rm --add-host=host.docker.internal:host-gateway curlimages/curl \
     curl -s http://host.docker.internal:11434/api/tags

   # Egress lockdown on: join the actual internal network
   docker run --rm --network nanoclaw-egress curlimages/curl \
     curl -s http://host.docker.internal:11434/api/tags
   ```

   Under lockdown the second command reaches the OneCLI gateway, not your
   daemon, and will not return Ollama's tag list. That is the expected,
   documented limitation — see Phase 1.

3. If the daemon binds only `127.0.0.1`, a container cannot reach it however the
   network is set up. Set `OLLAMA_HOST=0.0.0.0:11434` **on the Ollama daemon**
   (that is Ollama's own listen-address variable, unrelated to this skill's
   `--host`) and restart it.

### Management tools not showing up

`ncl groups config get --id <group-id>` — the args must contain
`--admin-tools`, and the group must have been restarted since. Nothing in
`.env` affects this.

### `model not found` / 404 on generate

The `model` argument must match a name from `ollama_list_models` exactly,
including the `:tag` suffix (`gemma3:1b`, not `gemma3`). Ask the agent to list
first and pick from that list.

### `ollama_pull_model` times out on large models

The tool uses `stream: false` and blocks until the pull finishes; 7B+ models can
take several minutes. For very large pulls, run `ollama pull <model>` on the
host instead.

### Slow first response

Ollama lazy-loads a model into memory on first use. Later calls against the same
model are fast.

### The agent has the tools but does not use them

Be explicit: "use the ollama_generate tool with gemma3:1b to answer: ...".
