---
name: add-opencode
description: Use OpenCode as an agent provider. OpenRouter, OpenAI, Google, DeepSeek, etc. via OpenCode config — not the Anthropic Agent SDK. Per group via `ncl groups config update --provider opencode`; host passes OPENCODE_* and XDG mount when spawning containers.
---

# OpenCode agent provider

NanoClaw runs agents in a long-lived **poll loop** inside the container. The backend is selected per agent group by the **`provider`** key in that group's `container.json` (materialized from the `container_configs` table) — set it with `ncl groups config update --provider opencode`. Default is `claude`.

Trunk ships with only the `claude` provider baked in. This skill copies the OpenCode provider files in from the `providers` branch, wires them into the host and container barrels, installs dependencies, and rebuilds the image.

## Install

### 1. Copy the provider payload

Fetch the `providers` branch from the configured remote that carries it, then
overwrite every skill-owned provider file with its canonical registry copy:

```nc:copy from-branch:providers
src/providers/opencode.ts
src/providers/opencode-registration.test.ts
container/agent-runner/src/providers/opencode.ts
container/agent-runner/src/providers/mcp-to-opencode.ts
container/agent-runner/src/providers/mcp-to-opencode.test.ts
container/agent-runner/src/providers/opencode-registration.test.ts
container/agent-runner/src/providers/opencode.attachments.test.ts
container/agent-runner/src/providers/opencode.compaction.test.ts
container/agent-runner/src/providers/opencode.config.test.ts
container/agent-runner/src/providers/opencode.factory.test.ts
container/agent-runner/src/providers/opencode.memory.test.ts
container/agent-runner/src/providers/opencode.question.test.ts
```

(`cwd-shim.ts` and its test are deliberately **not** in this payload even though `mcp-to-opencode.ts` imports the shim: trunk ships and owns them — the default provider imports `cwd-shim.ts` — and every path listed here becomes a skill-owned file that removal deletes.)

### 2. Register the provider in both runtimes

Each barrel gets one line appended at the end — skip if the line is already present.

```nc:append to:src/providers/index.ts
import './opencode.js';
```

```nc:append to:container/agent-runner/src/providers/index.ts
import './opencode.js';
```

### 3. Install the matched SDK and CLI pins

The agent-runner is a separate Bun package tree. Keep its SDK on the same exact
version as the globally installed `opencode-ai` CLI:

```nc:dep manager:bun cwd:container/agent-runner
@opencode-ai/sdk@1.4.17
```

```nc:json-merge into:container/cli-tools.json key:name
{
  "name": "opencode-ai",
  "version": "1.4.17"
}
```

Do not use `latest`. OpenCode's CLI and SDK have changed their session API in
lockstep before; mismatched versions can build cleanly and fail at runtime.

### 4. Install the pin guard

Copy the structural test that asserts the CLI manifest and SDK package stay on
the same exact version:

```nc:copy
opencode-cli-tools.test.ts -> src/opencode-cli-tools.test.ts
```

### 5. Build and validate

```nc:run effect:build
pnpm run build
```

```nc:run effect:build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```

```nc:run effect:test
pnpm exec vitest run src/providers/opencode-registration.test.ts src/opencode-cli-tools.test.ts
```

```nc:run effect:test
cd container/agent-runner && bun test src/providers/opencode-registration.test.ts
```

```nc:run effect:build
./container/build.sh
```

All checks must be clean before proceeding. The registration tests import the
real host and container barrels; the pin guard covers the non-importable global
CLI; the two typechecks cover both runtime API boundaries.

NanoClaw v2 mounts one shared read-only agent-runner source tree. There are no
per-group source overlays to propagate or repair.

## Configuration

### Host `.env` (typical)

Set model/provider strings in the form OpenCode expects (often `provider/model-id`). **Put comments on their own lines** — a `#` inside a value is kept verbatim and breaks model IDs.

These variables are read **on the host** and passed into the container only when the effective provider is `opencode`. They do not switch the provider by themselves; the group still needs `provider` set to `opencode` (see [Select the provider](#select-the-provider) below).

- `OPENCODE_PROVIDER` — OpenCode provider id, e.g. `openrouter`, `anthropic`, `deepseek`.
- `OPENCODE_MODEL` — full model id in `provider/model` form, e.g. `deepseek/deepseek-chat`.
- `OPENCODE_SMALL_MODEL` — optional second model for lighter tasks; defaults to `OPENCODE_MODEL` if unset.
- `ANTHROPIC_BASE_URL` — **required for non-`anthropic` providers.** The opencode container provider passes this as the `baseURL` for the upstream provider config so requests route through OneCLI's credential proxy or directly to the provider's API. Set it to the provider's API base URL (e.g. `https://api.deepseek.com/v1`, `https://openrouter.ai/api/v1`).

Credentials: register provider API keys in OneCLI with the matching `--host-pattern` (e.g. `api.deepseek.com`, `openrouter.ai`). OneCLI injects them via `HTTPS_PROXY` in the container — the key never lives in `.env` or the container environment.

After adding a secret, **grant the agent access** — agents in `selective` mode only receive secrets they've been explicitly assigned:

Use the safe merge pattern — `set-secrets` replaces the entire list, so always read first:

```bash
AGENT_ID=$(onecli agents list | jq -r '.data[] | select(.identifier=="<agentGroupId>") | .id')
CURRENT=$(onecli agents secrets --id "$AGENT_ID" | jq -r '[.data[]] | join(",")')
MERGED=$(printf '%s' "$CURRENT,<new-secret-id>" | tr ',' '\n' | sort -u | paste -sd ',' -)
onecli agents set-secrets --id "$AGENT_ID" --secret-ids "$MERGED"
onecli agents secrets --id "$AGENT_ID"
```

#### Example: DeepSeek

```env
OPENCODE_PROVIDER=deepseek
OPENCODE_MODEL=deepseek/deepseek-chat
OPENCODE_SMALL_MODEL=deepseek/deepseek-chat
ANTHROPIC_BASE_URL=https://api.deepseek.com/v1
```

Register the key:

```bash
onecli secrets create --name "DeepSeek" --type generic \
  --value YOUR_KEY --host-pattern "api.deepseek.com" \
  --header-name "Authorization" --value-format "Bearer {value}"
```

#### Example: OpenRouter

```env
OPENCODE_PROVIDER=openrouter
OPENCODE_MODEL=openrouter/anthropic/claude-sonnet-4
OPENCODE_SMALL_MODEL=openrouter/anthropic/claude-haiku-4.5
ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1
```

Register the key:

```bash
onecli secrets create --name "OpenRouter" --type generic \
  --value YOUR_KEY --host-pattern "openrouter.ai" \
  --header-name "Authorization" --value-format "Bearer {value}"
```

#### Example: Anthropic (no ANTHROPIC_BASE_URL needed)

When `OPENCODE_PROVIDER` is `anthropic`, OpenCode uses normal Anthropic env inside the container — the proxy + placeholder key pattern is unchanged and `ANTHROPIC_BASE_URL` is not required.

```env
OPENCODE_PROVIDER=anthropic
OPENCODE_MODEL=anthropic/claude-sonnet-4-20250514
OPENCODE_SMALL_MODEL=anthropic/claude-haiku-4-5-20251001
```

#### OpenCode Zen (`x-api-key`, not Bearer)

Zen's HTTP API (e.g. `POST …/zen/v1/messages`) expects the key in the **`x-api-key`** header. If OneCLI injects **`Authorization: Bearer …`** only, Zen often returns **401 / "Missing API key"** even though the gateway is working.

**Naming:** NanoClaw's **`provider: opencode`** (the `container.json` key, set via `ncl groups config update --provider opencode`) means "run the **OpenCode agent provider**." Separately, **`OPENCODE_PROVIDER=opencode`** in `.env` is OpenCode's **Zen provider id** inside the OpenCode config (see [Zen docs](https://opencode.ai/docs/zen/)).

**Host `.env` (typical Zen shape):**

```env
OPENCODE_PROVIDER=opencode
OPENCODE_MODEL=opencode/big-pickle
OPENCODE_SMALL_MODEL=opencode/big-pickle
ANTHROPIC_BASE_URL=https://opencode.ai/zen/v1
```

Use a real Zen model id from the docs; `big-pickle` is one example.

**OneCLI:** register the Zen key with **`x-api-key`**, not Bearer:

```bash
onecli secrets create --name "OpenCode Zen" --type generic \
  --value YOUR_ZEN_KEY --host-pattern opencode.ai \
  --header-name "x-api-key" --value-format "{value}"
```

### Select the provider

Per group, from the host:

```bash
ncl groups config update --id <group-id> --provider opencode
ncl groups restart --id <group-id>
```

`ncl groups config update --provider` writes the `provider` value into the `container_configs` table; the host materializes it into `groups/<folder>/container.json` at spawn time and the in-container runner reads `provider` from there (defaulting to `claude`). The restart picks up the change. Switching is an operator action — run it from the host. Memory does NOT carry over automatically between providers — run `/migrate-memory` to carry it across.

Extra MCP servers still come from **`NANOCLAW_MCP_SERVERS`** / `container_config.mcpServers` on the host; the runner merges them into the same `mcpServers` object passed to **both** Claude and OpenCode providers.

## Operational notes

- OpenCode keeps a local **`opencode serve`** process and SSE subscription; the provider tears down with **`stream.return`** and **SIGKILL** on the server process on **`abort()`** / shared runtime reset to avoid MCP/zombie hangs.
- Session continuation uses UUID format (SDK 1.4.x / CLI 1.4.x). Stale sessions are cleared by `isSessionInvalid` on OpenCode-specific error patterns. If you see UUID-related errors after an accidental CLI upgrade, clear `session_state` in `outbound.db` and wipe the `opencode-xdg` directory under the session folder.
- **`NO_PROXY`** for localhost matters when the OpenCode client talks to `127.0.0.1` inside the container while HTTP(S)\_PROXY is set (e.g. OneCLI).

## Next steps

The host/container registration tests and the CLI/SDK pin guard verify the
static wiring. To confirm a live round-trip, switch a test group with
`ncl groups config update --id <group-id> --provider opencode && ncl groups
restart --id <group-id>`, register the matching provider key in OneCLI, and
send a message. A clean exchange returns the model's reply with no `Unknown
provider: opencode` error and no UUID/session warnings in the logs.

To remove this provider, see [REMOVE.md](REMOVE.md).
