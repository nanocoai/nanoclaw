# Running Agents on Local llmman

NanoClaw agents can be routed to a local [llmman](https://github.com/llmmanorg/llmman) daemon instead of the Anthropic API. This cuts API costs to zero and keeps all inference on your hardware. llmman is a sibling to [Ollama](ollama.md): the setup is the same shape, with llmman's own port, model names and authentication.

## How It Works

`llmman serve` listens on `127.0.0.1:17434` and speaks the Ollama, OpenAI and Anthropic wire formats on that one endpoint, including `/v1/messages`. The Claude Code CLI (which runs inside agent containers) uses the Anthropic SDK, which reads `ANTHROPIC_BASE_URL` to find the API host. Pointing that variable at llmman is all that's needed — no new provider code, no changes to the agent runtime.

```
┌─────────────────────────────┐
│  Agent container            │
│                             │
│  Claude Code CLI            │
│    ↓ ANTHROPIC_BASE_URL     │
│    http://host.docker.      │      ┌──────────────────┐
│    internal:17434    ───────┼─────▶│  llmman :17434   │
│                             │      │  qwen3.8         │
└─────────────────────────────┘      └──────────────────┘
```

`host.docker.internal` is Docker's magic hostname that resolves to the host machine from inside a container — so llmman running on your Mac or Linux box is reachable at that address (on Linux, see [Reaching the Daemon](#reaching-the-daemon-and-api-keys)).

llmman loads a model on the first request that names it and unloads it after an idle `keep_alive` (five minutes by default). Models come from an OCI registry or Hugging Face: `llmman pull qwen3.8`, `llmman pull hf.co/org/model`. `llmman list` shows what is stored and `llmman ps` what is loaded.

## The Credential Gateway Complication

NanoClaw normally runs API calls through its credential gateway's HTTPS proxy, which injects real credentials in place of a placeholder key. When redirecting to llmman you need to bypass that proxy so requests go direct. Two env vars handle this:

- `NO_PROXY=host.docker.internal` — tells the Anthropic SDK's HTTP client to skip the proxy for that hostname
- `no_proxy=host.docker.internal` — lowercase variant for tools that check the lowercase form

Both are set in the agent group's `container.json` alongside `ANTHROPIC_BASE_URL`.

If this install uses Iron Proxy, its "Serve a local model" section (in the `add-iron-proxy` skill) admits a keyless model at `http://host.docker.internal:<port>/v1` and only the OpenAI inference routes. llmman serves `/v1/models` and `/v1/chat/completions` there, so it fits that path for providers that use them. Whether the `NO_PROXY` bypass above reaches llmman under Iron's egress rules has not been tested.

## Network Isolation

Setting `ANTHROPIC_BASE_URL` redirects requests but doesn't prevent a misconfigured agent from accidentally reaching `api.anthropic.com` directly. The `blockedHosts` field in `container.json` adds a Docker `--add-host` flag that resolves the domain to `0.0.0.0`, making it physically unreachable from inside the container:

```json
"blockedHosts": ["api.anthropic.com"]
```

With this in place, even if the model setting drifts back to a Claude model name, the API call will fail immediately rather than silently billing your account.

## Reaching the Daemon, and API Keys

`llmman serve` binds `127.0.0.1` by default and is open (no key) there.

- **Docker Desktop (macOS, Windows):** `host.docker.internal` reaches a loopback-bound daemon. The default setup works as is.
- **Linux:** a container reaches the host through the Docker bridge, not host loopback. The daemon has to listen on an address the bridge can reach, for example `LLMMAN_HOST=0.0.0.0:17434` or the bridge address (often `172.17.0.1`). llmman refuses to start on an address the network can reach unless `LLMMAN_API_KEYS` is set (a comma-separated key list), or `LLMMAN_AUTH=off` says the omission is deliberate.

Once `LLMMAN_API_KEYS` is set, every route requires a key, as `Authorization: Bearer <key>` or `x-api-key: <key>`. The Claude Code CLI sends `ANTHROPIC_API_KEY` as `x-api-key`, so set that variable in the agent group's `container.json` to one of the daemon's keys (the MCP tool from `/add-llmman-tool` sends `LLMMAN_API_KEY` as a Bearer token).

Treat that key with care. It sits in the container's environment where the agent can read it. And llmman's API docs note that an authenticated caller is treated as the operator: the daemon spends its own hosted-provider keys (`llmman providers`) for it. Make a key for this install (`openssl rand -hex 24`) and keep hosted-provider keys off a daemon an agent can reach.

## Model Selection

The Claude Code CLI reads its model from `~/.claude/settings.json` inside the container, which NanoClaw bind-mounts from `data/v2-sessions/<agent-group-id>/.claude-shared/settings.json`. Set `"model": "qwen3.8"` (or whatever llmman model you've pulled) there. Use the name shown by `llmman list` or returned by `/api/tags`.

Claude Code also sends background and subagent requests under Claude model names (a `haiku` alias, for example). llmman cannot serve those: it treats an unknown name as a registry reference to pull, and the request fails. `container.json` therefore also sets `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL` to the same model. `llmman launch claude` sets this same group of variables for the same reason.

The agent uses tool calls extensively (read/write files, shell commands), so pick a model that supports them. `POST /api/show` reports a model's `capabilities` — look for `tools` (the chat template renders tool definitions) and, for reasoning models, `thinking`. Model size, speed and quality depend on your hardware; `llmman search` shows how much of this machine's model memory each default download takes.

## Prompt Caching (the cch hash)

[docs/ollama.md](ollama.md#allowing-prompt-caching-filter-the-cache-busting-hash) describes a slow path on Ollama: the Claude Agent SDK puts a per-request `cch=<hash>` value at the front of the prompt, which can defeat prefix-based prompt caching. This section records what could and could not be established for llmman. The Ollama guide's numbers are not claimed here.

**Confirmed from llmman's docs and source:**

- llmman reports how much of a prompt came from cache: `prompt_eval_cached_count` on `/api/chat` and `/api/generate`, and `cache_read_input_tokens` in the usage block of `/v1/messages` replies.
- For a local model, `/v1/messages` is translated to a chat completion. All `system` blocks are folded, as received, into one leading system message; llmman does not filter or rewrite any attribution or billing text in them (its source has no handling for `x-anthropic-billing-header` or `cch`).
- Anthropic cache breakpoints and `anthropic-beta` headers have no chat-completion form and are dropped for a local model, so caching there is the backend's own prompt reuse.

**Not confirmed:** whether the SDK's `cch` value reaches llmman inside `system` on this path, whether it defeats the backend's prefix reuse, and how much a normalizing proxy would help. None of this has been run against a live llmman daemon. This guide does not claim the slowdown or a speedup for llmman.

**How to check.** Run two consecutive turns in an agent group routed to llmman. If `cache_read_input_tokens` (or `prompt_eval_cached_count`) stays near zero on the second turn while the prompt is long, the same cause is plausible. The dependency-free proxy in the Ollama guide forwards every header, including `x-api-key` and `Authorization`, and rewrites only the `cch=<hex>;` text, so it can sit in front of llmman too: set its target host and port (its `OLLAMA_HOST` / `OLLAMA_PORT` variables) to llmman's and point `ANTHROPIC_BASE_URL` at the proxy. That use is untested.

## What Changes at the Code Level

The code changes are the same three files as for Ollama. See `/add-llmman-provider` for the exact changes; if `/add-ollama-provider` already applied them, they are already in place.

**`src/container-config.ts`** — `ContainerConfig` interface needs `env` and `blockedHosts` fields so the per-group JSON can carry them.

**`src/container-runner.ts`** — At container spawn time, `env` entries become `-e KEY=VAL` Docker flags (applied after the gateway's injected vars so they win), and `blockedHosts` entries become `--add-host HOST:0.0.0.0` flags.

**`container/Dockerfile`** — The container runs as the host user's uid (e.g. 501 on macOS), not as the `node` user (uid 1000). The home directory must be `chmod 777` so any uid can write `~/.claude.json` and `~/.claude/settings.json`.

## Tradeoffs

| | llmman (local) | Anthropic API |
|---|---|---|
| Cost | Free | Pay-per-token |
| Privacy | Fully local | Data sent to Anthropic |
| Model quality | Good (open-weight) | Excellent (Claude) |
| Cold start | Model load on first request (seconds to minutes, by model size) | ~1s |
| Context window | Up to the model's trained context (256k default cap, `LLMMAN_CONTEXT_LENGTH`) | 200k tokens (Sonnet) |
| Tool use reliability | Good (large models) | Excellent |
| Hardware req. | Depends on the model (`llmman search` shows the fit) | None |

For personal automation on capable hardware, the tradeoff favors local. For complex multi-step tasks requiring large context or high reliability, Claude is still ahead.

### llmman and Ollama side by side

Both serve this path through `/v1/messages`; choose by how you want to manage models. Drawn from llmman's README and API docs:

| | llmman | Ollama |
|---|---|---|
| Default endpoint | `127.0.0.1:17434` (`LLMMAN_HOST`) | `127.0.0.1:11434` (`OLLAMA_HOST`) |
| API formats on one endpoint | Ollama, OpenAI, Anthropic | Ollama, OpenAI, Anthropic |
| Model sources | OCI registries (Docker Hub, GHCR, ...) and Hugging Face directly | ollama.com library |
| Authentication | Optional API keys (`LLMMAN_API_KEYS`); required on a non-loopback bind | Keyless local server |
| NanoClaw skills | `/add-llmman-provider`, `/add-llmman-tool` | `/add-ollama-provider`, `/add-ollama-tool` |

The two can be installed side by side: each tool skill has its own server name, tool prefix, env vars and log prefix, and each agent group points at one daemon.

## If Containers Get Killed Mid-Turn

A slow local model can hit the host sweep's timers, exactly as with Ollama: `NANOCLAW_ABSOLUTE_CEILING_MS` (default 30 minutes; streamed output counts as activity, so a slow load or long prompt read hits this one) and `NANOCLAW_CLAIM_STUCK_MS` (default 60 seconds). Raise the one the host log names, in `.env`, and restart the host. The details are in [docs/ollama.md](ollama.md#if-containers-get-killed-mid-turn).

## Reverting to Claude

Remove the `env` and `blockedHosts` keys from `groups/<folder>/container.json`, remove `"model"` from the shared settings file, and restart the service. No rebuild needed.

## See Also

- `/add-llmman-provider` — step-by-step skill to configure any agent group for llmman
- `/add-llmman-tool` — MCP tools that let a Claude agent call llmman models
- [docs/ollama.md](ollama.md) — the same setup for Ollama
- [llmman](https://github.com/llmmanorg/llmman) — its README, plus `docs/api.md` (the Anthropic, Ollama and OpenAI API notes, and authentication) and `docs/configuration.md` (`LLMMAN_HOST`, `LLMMAN_API_KEYS` and the other daemon settings)
- `docs/architecture.md` — how the container spawn and env injection pipeline works
