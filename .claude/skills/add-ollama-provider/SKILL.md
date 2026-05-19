---
name: add-ollama-provider
description: Route a NanoClaw agent group to a local Ollama model instead of the Anthropic API. Ollama speaks the Anthropic API natively (v1/messages), so no provider code changes are needed — just env var overrides and a model setting. Use when the user wants to run their agent locally, cut API costs, or experiment with open-weight models. See docs/ollama.md for background.
---

# Add Ollama Provider

Routes an agent group to a local Ollama instance instead of the Anthropic API.
See `docs/ollama.md` for how this works and the tradeoffs involved.

## Prerequisites

1. **Ollama is installed and running** on the host — verify: `curl -s http://localhost:11434/api/tags`
2. **A model is pulled** — e.g. `ollama pull gemma4` or `ollama pull qwen3-coder`
3. **The agent group already exists** — run `/init-first-agent` first if needed

## 1. Check source support

The feature requires two fields in `ContainerConfig` (`env` and `blockedHosts`) and their
corresponding wiring in `container-runner.ts`. Check if already present:

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
2. **Which Ollama model?** List available: `curl -s http://localhost:11434/api/tags | grep '"name"'`
3. **Block Anthropic API?** Recommended yes — prevents accidental spend if config drifts.

Record as `FOLDER`, `MODEL`, and `BLOCK_ANTHROPIC`.

## 3. Configure container.json

Read `groups/<FOLDER>/container.json`. Add (or merge into) an `env` block and optionally `blockedHosts`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://host.docker.internal:11434",
    "ANTHROPIC_API_KEY": "ollama",
    "NO_PROXY": "host.docker.internal",
    "no_proxy": "host.docker.internal"
  },
  "blockedHosts": ["api.anthropic.com"]
}
```

Omit `blockedHosts` if the user declined step 2.

**Why these vars:** `ANTHROPIC_BASE_URL` redirects the Anthropic SDK to Ollama.
`ANTHROPIC_API_KEY=ollama` satisfies the SDK's key requirement (Ollama ignores it).
`NO_PROXY` bypasses the OneCLI HTTPS proxy for requests to `host.docker.internal`
so they reach Ollama directly instead of going through the credential gateway.

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
  "model": "gemma4:latest"
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
# Ollama shows the model as active
curl -s http://localhost:11434/api/ps | grep '"name"'

# Container has the right env vars
CTR=$(docker ps --filter "name=nanoclaw-v2-<FOLDER>" --format "{{.Names}}" | head -1)
docker inspect "$CTR" --format '{{json .HostConfig.ExtraHosts}}'
docker exec "$CTR" env | grep ANTHROPIC
```

Expected: `api.anthropic.com:0.0.0.0` in ExtraHosts, `ANTHROPIC_BASE_URL=http://host.docker.internal:11434`.

## Reverting to Claude

To switch back to the Anthropic API:

1. Remove the `env` and `blockedHosts` keys from `groups/<FOLDER>/container.json`
2. Remove `"model"` from the shared settings file
3. Restart the service

No rebuild needed — both files are read at container spawn time.

## Troubleshooting

**Agent hangs, no response:** Ollama may be loading the model cold (large models take 10–30s).
Watch `curl -s http://localhost:11434/api/ps` — the model appears once loaded.

**"model not found" error in container logs:** The model name in settings.json doesn't match
what Ollama has. Run `ollama list` on the host and use the exact name shown.

**Responses claim to be Claude:** The model was trained on data that includes Claude conversations.
Add a line to `groups/<FOLDER>/CLAUDE.md` telling it what model it runs on.

**Agent responds but Ollama shows no activity:** `NO_PROXY` may not have taken effect for
`http_proxy` (lowercase). Add both `NO_PROXY` and `no_proxy` to the env block.
