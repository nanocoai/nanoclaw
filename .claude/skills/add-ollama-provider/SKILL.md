---
name: add-ollama-provider
description: Route NanoClaw agent groups through a local Ollama daemon using the Claude Agent SDK and Ollama's Anthropic-compatible API. Use for local models, offline inference, or the `ollama launch nanoclaw` setup.
---

# Add Ollama provider

Install an `ollama` provider that reuses NanoClaw's Claude runtime while routing
requests to the local Ollama daemon. The provider is selectable per agent group;
other groups keep their existing provider.

## Apply

### 1. Copy the provider payload and integration tests

Fetch the `providers` branch and copy the Ollama host and container providers
with their registration and tool-policy tests. The registry branch is the
canonical source, so re-applying the skill overwrites these files.

```nc:copy from-branch:providers
src/providers/ollama.ts
src/providers/ollama.test.ts
src/providers/ollama-registration.test.ts
container/agent-runner/src/providers/ollama.ts
container/agent-runner/src/providers/ollama.test.ts
container/agent-runner/src/providers/ollama-registration.test.ts
container/agent-runner/src/providers/ollama-tool-policy.test.ts
container/agent-runner/src/mcp-tools/ollama-web.ts
container/agent-runner/src/mcp-tools/ollama-web.test.ts
```

### 2. Register both provider halves

```nc:append to:src/providers/index.ts
import './ollama.js';
```

```nc:append to:container/agent-runner/src/providers/index.ts
import './ollama.js';
```

```nc:append to:container/agent-runner/src/mcp-tools/index.ts
import './ollama-web.js';
```

### 3. Build and validate

```nc:run effect:build
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```

```nc:run effect:test
pnpm exec vitest run src/providers/ollama-registration.test.ts src/providers/ollama.test.ts src/container-runner.test.ts
```

```nc:run effect:test
cd container/agent-runner && bun test src/providers/ollama.test.ts src/providers/ollama-registration.test.ts src/providers/ollama-tool-policy.test.ts src/mcp-tools/ollama-web.test.ts
```

## Configure an agent group

The default endpoint is `http://host.docker.internal:11434`. To use another
host-visible Ollama endpoint, convert loopback to a container-reachable address
and persist it before restarting NanoClaw:

```bash
pnpm exec tsx setup/index.ts --step set-env -- --key OLLAMA_BASE_URL --value http://host.docker.internal:11434
```

Set the provider and exact model name, then restart the group:

```bash
ncl groups config update --id <agent-group-id> --provider ollama --model <model>
ncl groups restart --id <agent-group-id>
```

The provider sends a placeholder token directly to Ollama, blocks Anthropic and
Claude service hosts, and disables Claude Code's cloud-only integrations and
background traffic. Web browsing defaults to disabled. When
`OLLAMA_WEB_BROWSING=enabled`, native `WebSearch` and an Ollama-backed
`WebFetch` alias both use the local daemon's hosted Ollama endpoints; NanoClaw
does not receive or store an Ollama API key. The local `agent-browser` remains
available for interactive browser work. Nothing else needs editing: no group
`container.json`, Claude settings file, proxy, or API key.

Behavior details, including the `WebFetch` preflight skip and the
runaway-generation caps: `docs/ollama.md`.

## Troubleshooting

- **No response:** verify `curl -sf http://localhost:11434/api/tags` succeeds on the host.
- **Model not found:** use the exact name from `ollama list`.
- **Container calls Anthropic:** confirm the group's provider is `ollama` with `ncl groups config get --id <agent-group-id>`.
