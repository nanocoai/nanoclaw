---
name: add-llmman-provider
description: Route a NanoClaw agent group to a local llmman model instead of the Anthropic API. llmman speaks the Anthropic API natively (v1/messages), so no provider code changes are needed — just env var overrides and a model setting. Use when the user wants to run their agent locally, cut API costs, or experiment with open-weight models. See docs/llmman.md for background.
---

# Add llmman Provider

Routes an agent group to a local llmman daemon (`llmman serve`) instead of the Anthropic API.
See `docs/llmman.md` for how this works and the tradeoffs involved.

## Prerequisites

1. **llmman is installed and running** on the host — verify: `curl -s http://localhost:17434/api/tags`
   (install with `curl -fsSL https://llmmanorg.github.io/install.sh | sh` or `brew install llmmanorg/tap/llmman`, then run `llmman serve`)
2. **A model is pulled** — e.g. `llmman pull qwen3.8` or `llmman pull hf.co/unsloth/Qwen3.5-0.8B-GGUF`
3. **The daemon is reachable from containers** — Docker Desktop reaches a loopback-bound daemon at
   `host.docker.internal`; on Linux the daemon must listen on an address the Docker bridge can reach
   (e.g. `LLMMAN_HOST=0.0.0.0:17434 llmman serve`), and llmman then refuses to start unless
   `LLMMAN_API_KEYS` is set (or `LLMMAN_AUTH=off`). See step 2 and the Troubleshooting section.
4. **The agent group already exists** — run `/init-first-agent` first if needed

## 1. Check source support

The feature requires two fields in `ContainerConfig` (`env` and `blockedHosts`) and their
corresponding wiring in `container-runner.ts`. Check if already present (for example from
`/add-ollama-provider`, which uses the same two fields):

```bash
grep -c 'blockedHosts' src/container-config.ts src/container-runner.ts
```

If either count is 0, apply the changes in steps 1a and 1b. Otherwise skip to step 2.

### 1a. Extend ContainerConfig

In `src/container-config.ts`, add to the `ContainerConfig` interface:

```typescript
env?: Record<string, string>;
blockedHosts?: string[];
```

And in `readContainerConfig`, add inside the returned object:

```typescript
env: raw.env,
blockedHosts: raw.blockedHosts,
```

### 1b. Wire into container-runner

In `src/container-runner.ts`, after the `NANOCLAW_MCP_SERVERS` block, add:

```typescript
// Per-agent-group env overrides — applied last to win over OneCLI values.
if (containerConfig.env) {
  for (const [key, value] of Object.entries(containerConfig.env)) {
    args.push('-e', `${key}=${value}`);
  }
}

// Blocked hosts: resolve to 0.0.0.0 so they are unreachable inside the container.
if (containerConfig.blockedHosts) {
  for (const host of containerConfig.blockedHosts) {
    args.push('--add-host', `${host}:0.0.0.0`);
  }
}
```

### 1c. Fix home directory permissions (if not already done)

The container may run as your host uid (not uid 1000). Check the Dockerfile:

```bash
grep 'chmod.*home/node' container/Dockerfile
```

If it shows `chmod 755`, change it to `chmod 777` so any uid can write there.
Then rebuild the container image: `./container/build.sh`

## 2. Identify the setup

Ask the user (plain text, not AskUserQuestion):

1. **Which agent group?** List available groups: `pnpm exec tsx scripts/q.ts data/v2.db "SELECT folder, name FROM agent_groups;"`
2. **Which llmman model?** List available: `curl -s http://localhost:17434/api/tags | grep '"name"'` (or `llmman list`)
3. **Does the daemon require an API key?** Yes if it was started with `LLMMAN_API_KEYS` (required on a Linux bind the Docker bridge can reach). If yes, which key should this agent group present? Use a key made for it (`openssl rand -hex 24`, added to `LLMMAN_API_KEYS`).
4. **Block Anthropic API?** Recommended yes — prevents accidental spend if config drifts.

Record as `FOLDER`, `MODEL`, `API_KEY` (or none), and `BLOCK_ANTHROPIC`.

## 3. Configure container.json

Read `groups/<FOLDER>/container.json`. Add (or merge into) an `env` block and optionally `blockedHosts`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://host.docker.internal:17434",
    "ANTHROPIC_API_KEY": "llmman",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "<MODEL>",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "<MODEL>",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "<MODEL>",
    "ANTHROPIC_SMALL_FAST_MODEL": "<MODEL>",
    "CLAUDE_CODE_SUBAGENT_MODEL": "<MODEL>",
    "NO_PROXY": "host.docker.internal",
    "no_proxy": "host.docker.internal"
  },
  "blockedHosts": ["api.anthropic.com"]
}
```

Omit `blockedHosts` if the user declined step 2. If the daemon requires a key, set
`ANTHROPIC_API_KEY` to that key instead of `llmman`.

**Why these vars:** `ANTHROPIC_BASE_URL` redirects the Anthropic SDK to llmman.
`ANTHROPIC_API_KEY=llmman` satisfies the SDK's key requirement (an open llmman daemon ignores it);
with `LLMMAN_API_KEYS` set, the SDK sends the key as `x-api-key`, which llmman accepts.
The `*_MODEL` variables point Claude Code's background and subagent requests at your model — they
otherwise ask for Claude model names, which llmman cannot serve: it treats an unknown name as a
registry reference to pull, and fails (`llmman launch claude` sets the same variables).
`NO_PROXY` bypasses the credential gateway's HTTPS proxy for requests to `host.docker.internal`
so they reach llmman directly instead of going through the gateway.

**Key handling:** the container's environment is readable by the agent, so give it a key made for
this agent group, not one that does anything else. A key that opens the daemon also lets the
caller spend any hosted-provider keys the daemon holds (`llmman providers`), so keep those off a
daemon an agent can reach.

## 4. Set the model

Read the agent group's shared Claude settings:

```bash
# Find the agent group ID
AG_ID=$(pnpm exec tsx scripts/q.ts data/v2.db "SELECT id FROM agent_groups WHERE folder='<FOLDER>';")
SETTINGS=data/v2-sessions/$AG_ID/.claude-shared/settings.json
```

Add `"model": "<MODEL>"` to that settings file. Create the file if it doesn't exist:

```json
{
  "model": "qwen3.8"
}
```

If the file already has content, merge the `model` key in — don't overwrite existing keys.

**Why here and not container.json:** Claude Code reads its model from its own settings
file, not from env vars. This file is bind-mounted into the container as `~/.claude/settings.json`.

## 5. Build and restart

Run from your NanoClaw project root:

```bash
export PATH="/opt/homebrew/bin:$PATH"
pnpm run build
source setup/lib/install-slug.sh
launchctl unload ~/Library/LaunchAgents/$(launchd_label).plist
launchctl load   ~/Library/LaunchAgents/$(launchd_label).plist
# Linux: systemctl --user restart $(systemd_unit)
```

## 6. Verify

Send a message to the agent. Then confirm:

```bash
# llmman shows the model as loaded (add -H "x-api-key: <key>" if the daemon requires one)
curl -s http://localhost:17434/api/ps | grep '"name"'

# Container has the right env vars
CTR=$(docker ps --filter "label=nanoclaw-group-folder=<FOLDER>" --format "{{.Names}}" | head -1)
docker inspect "$CTR" --format '{{json .HostConfig.ExtraHosts}}'
docker exec "$CTR" env | grep ANTHROPIC
```

Expected: `api.anthropic.com:0.0.0.0` in ExtraHosts, `ANTHROPIC_BASE_URL=http://host.docker.internal:17434`.

## Reverting to Claude

To switch back to the Anthropic API:

1. Remove the `env` and `blockedHosts` keys from `groups/<FOLDER>/container.json`
2. Remove `"model"` from the shared settings file
3. Restart the service

No rebuild needed — both files are read at container spawn time.

## Troubleshooting

**Agent hangs, no response:** llmman loads models on demand, so the first request after an idle
period waits for the load (large models take 10–30s; llmman gives a stalled load 10 minutes by default,
`LLMMAN_LOAD_TIMEOUT`).
Watch `curl -s http://localhost:17434/api/ps` — the model appears once loaded.

**"model not found" error in container logs:** The model name in settings.json doesn't match
what llmman has. Run `llmman list` on the host and use the exact name shown.

**Background or subagent requests fail with "pull failed" or "model not found" for a `claude-…` name:**
The `*_MODEL` variables from step 3 are missing from `container.json`. Add them and restart.

**Connection refused from the container (Linux):** The daemon is bound to `127.0.0.1`, which a
container cannot reach through the Docker bridge. Restart it with
`LLMMAN_HOST=0.0.0.0:17434` (or the bridge address, often `172.17.0.1`) and `LLMMAN_API_KEYS=<key>`;
llmman will not start on such an address without a key unless `LLMMAN_AUTH=off`. Set
`ANTHROPIC_API_KEY` in `container.json` to that key.

**401 from llmman:** The daemon has `LLMMAN_API_KEYS` set and the agent group's
`ANTHROPIC_API_KEY` is not one of them.

**Responses claim to be Claude:** The model was trained on data that includes Claude conversations.
Add a line to `groups/<FOLDER>/CLAUDE.md` telling it what model it runs on.

**Agent responds but llmman shows no activity:** `NO_PROXY` may not have taken effect for
`http_proxy` (lowercase). Add both `NO_PROXY` and `no_proxy` to the env block.
