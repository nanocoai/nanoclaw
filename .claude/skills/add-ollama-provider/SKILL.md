---
name: add-ollama-provider
description: Route NanoClaw agent groups through a local Ollama daemon using the Claude Agent SDK and Ollama's Anthropic-compatible API. Use for local models, offline inference, or the `ollama launch nanoclaw` setup.
metadata:
  nanoclaw-provider: ollama
  nanoclaw-provider-label: Ollama
  nanoclaw-provider-hint: Local models through the Ollama daemon
  nanoclaw-provider-offered: 'false'
  nanoclaw-provider-image: hardened-compatible
---

# Add Ollama provider

Install an `ollama` provider that reuses NanoClaw's Claude runtime while routing
requests to the local Ollama daemon. Selectable per agent group; other groups
keep their provider. It stays out of the setup picker: `/setup-ollama-launch`
installs it.

## Apply

### 1. Copy the payload

Fetch the `providers` branch and copy the host and container halves: the two
provider modules, their host and runtime contracts, the direct web tools, and
their tests. The registry branch is canonical, so re-applying overwrites these.

```nc:copy from-branch:providers
src/providers/ollama.ts
src/providers/ollama.test.ts
src/providers/ollama-registration.test.ts
src/provider-contracts/ollama.ts
container/agent-runner/src/providers/ollama.ts
container/agent-runner/src/providers/ollama.test.ts
container/agent-runner/src/providers/ollama-registration.test.ts
container/agent-runner/src/providers/ollama-tool-policy.test.ts
container/agent-runner/src/providers/ollama.conformance.test.ts
container/agent-runner/src/provider-contracts/ollama.ts
container/agent-runner/src/mcp-tools/ollama-web.ts
container/agent-runner/src/mcp-tools/ollama-web.test.ts
```

### 2. Wire the barrels

Provider registration and contract registration are separate imports, so each
tree takes its own line (skipped if already present).

```nc:append to:src/providers/index.ts
import './ollama.js';
```

```nc:append to:src/provider-contracts/index.ts
import './ollama.js';
```

```nc:append to:container/agent-runner/src/providers/index.ts
import './ollama.js';
```

```nc:append to:container/agent-runner/src/provider-contracts/index.ts
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
pnpm exec vitest run src/providers/ollama.test.ts src/providers/ollama-registration.test.ts src/container-runner.test.ts
```

```nc:run effect:test
cd container/agent-runner && bun test src/providers/ollama.test.ts src/providers/ollama-registration.test.ts src/providers/ollama-tool-policy.test.ts src/providers/ollama.conformance.test.ts src/mcp-tools/ollama-web.test.ts
```

## Configure an agent group

The default endpoint is `http://host.docker.internal:11434`. For another
host-visible endpoint, convert loopback to a container-reachable address and
persist it before restarting NanoClaw:

```bash
pnpm exec tsx setup/index.ts --step set-env -- --key OLLAMA_BASE_URL --value http://host.docker.internal:11434
```

Then set the provider and the exact model name and restart the group:

```bash
ncl groups config update --id <agent-group-id> --provider ollama --model <model>
ncl groups restart --id <agent-group-id>
```

Nothing else needs editing: no group `container.json`, Claude settings file,
proxy, or API key. The provider sends a placeholder token to the daemon, blocks
the Anthropic and Claude service hosts, turns reasoning off when the group sets
no effort, and disables Claude Code's cloud-only integrations and background
traffic.

Web browsing is off by default. With `OLLAMA_WEB_BROWSING=enabled`, two MCP
tools call the daemon's signed Ollama Web Search and Web Fetch endpoints
directly instead of the slower model-orchestrated server-tool path, which stays
disabled; NanoClaw never receives an Ollama API key. The provider tells the
agent to use search for finding URLs, fetch for reading one, and to reserve
`agent-browser` for clicks, forms, sign-in state, and screenshots.

The provider instructions also make `approval-pending` a hard wait point (the
agent acknowledges, ends the turn, and resumes on the real result) and state
that an acknowledgment starts no background job, so a receiving agent finishes
the work before ending its turn. Agent creation and messaging stay
provider-neutral and never force the turn to end.

Behavior details, including the `WebFetch` preflight skip and the
runaway-generation caps: `docs/ollama.md`.

## Troubleshooting

- **No response:** verify `curl -sf http://localhost:11434/api/tags` succeeds on the host.
- **Model not found:** use the exact name from `ollama list`.
- **Container calls Anthropic:** confirm the group's provider is `ollama` with `ncl groups config get --id <agent-group-id>`.
