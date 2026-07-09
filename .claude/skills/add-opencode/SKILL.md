---
name: add-opencode
description: Use OpenCode as an agent provider. OpenRouter, OpenAI, Google, DeepSeek, etc. via OpenCode config — not the Anthropic Agent SDK. Per group via `ncl groups config update --provider opencode`; host passes OPENCODE_* and XDG mount when spawning containers.
---

# OpenCode agent provider

NanoClaw runs agents in a long-lived **poll loop** inside the container. The backend is selected per agent group by the **`provider`** key in that group's `container.json` (materialized from the `container_configs` table) — set it with `ncl groups config update --provider opencode`. Default is `claude`.

Trunk ships with only the `claude` provider baked in. This skill copies the OpenCode provider files in from the `providers` branch, wires them into the host and container barrels, installs dependencies, and rebuilds the image.

## Install

### Pre-flight

If all of the following are already present, skip to **Configuration**:

- `src/providers/opencode.ts`
- `container/agent-runner/src/providers/opencode.ts`
- `src/providers/opencode-registration.test.ts`
- `container/agent-runner/src/providers/opencode-registration.test.ts`
- `import './opencode.js';` line in `src/providers/index.ts`
- `import './opencode.js';` line in `container/agent-runner/src/providers/index.ts`
- `@opencode-ai/sdk` in `container/agent-runner/package.json`
- `ARG OPENCODE_VERSION` and `"opencode-ai@${OPENCODE_VERSION}"` in `container/Dockerfile`
- `src/opencode-dockerfile.test.ts` (the Dockerfile install guard)

Missing pieces — continue below. All steps are idempotent; re-running is safe.

### 1. Fetch the providers branch

```bash
git fetch origin providers
```

### 2. Copy the OpenCode source files

Wholesale copies (owned entirely by this skill — user edits to these files won't survive a re-run, as designed):

```bash
git show origin/providers:src/providers/opencode.ts                                     > src/providers/opencode.ts
git show origin/providers:container/agent-runner/src/providers/opencode.ts              > container/agent-runner/src/providers/opencode.ts
git show origin/providers:container/agent-runner/src/providers/mcp-to-opencode.ts       > container/agent-runner/src/providers/mcp-to-opencode.ts
git show origin/providers:container/agent-runner/src/providers/mcp-to-opencode.test.ts  > container/agent-runner/src/providers/mcp-to-opencode.test.ts
git show origin/providers:container/agent-runner/src/providers/opencode.factory.test.ts > container/agent-runner/src/providers/opencode.factory.test.ts
```

Also copy the two barrel-registration guards — one per tree. These import the real provider barrels and assert `opencode` is registered, so they go red the moment a barrel import line is deleted or drifts:

```bash
git show origin/providers:src/providers/opencode-registration.test.ts                          > src/providers/opencode-registration.test.ts
git show origin/providers:container/agent-runner/src/providers/opencode-registration.test.ts   > container/agent-runner/src/providers/opencode-registration.test.ts
```

### 3. Append the self-registration imports

Each barrel gets one line appended at the end — skip if the line is already present.

`src/providers/index.ts`:

```typescript
import './opencode.js';
```

`container/agent-runner/src/providers/index.ts`:

```typescript
import './opencode.js';
```

### 4. Add the agent-runner dependency

Pinned. Bump deliberately, not with `bun update`. Use `1.4.17` — must match the `opencode-ai` CLI version pinned in step 5. The 1.14.x SDK has a completely different API and is **incompatible** with the current provider code.

```bash
cd container/agent-runner && bun add @opencode-ai/sdk@1.4.17 && cd -
```

### 5. Add `opencode-ai` to the container Dockerfile

Two edits to `container/Dockerfile`, both idempotent (skip if already present):

**(a)** In the "Pin CLI versions" ARG block (around line 22), add after `ARG VERCEL_VERSION=...`:

```dockerfile
ARG OPENCODE_VERSION=1.4.17
```

> **Do not use `latest`** — the CLI and SDK must be the same version. `latest` silently upgrades the CLI to 1.14.x which has a breaking session API change (UUID session IDs → `ses_` prefix) incompatible with SDK 1.4.x.

**(b)** Add a new standalone `RUN` block for the OpenCode CLI, after the existing per-CLI install blocks (around line 111, right after the `@anthropic-ai/claude-code` block). The Dockerfile splits each global CLI into its own layer for cache granularity — keep that pattern; do not collapse them into a single combined `pnpm install -g` call:

```dockerfile
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "opencode-ai@${OPENCODE_VERSION}"
```

### 6. Copy the Dockerfile install guard

The `opencode-ai` CLI is a globally-installed binary — not importable or typed — so a structural test guards the Dockerfile install. Copy it into the host test tree:

```bash
cp .claude/skills/add-opencode/opencode-dockerfile.test.ts src/opencode-dockerfile.test.ts
```

### 7. Build and validate

```bash
pnpm run build                                                    # host
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit    # container typecheck
pnpm exec vitest run src/providers/opencode-registration.test.ts  # host registration guard
pnpm exec vitest run src/opencode-dockerfile.test.ts              # Dockerfile install guard
cd container/agent-runner && bun test src/providers/opencode-registration.test.ts && cd -  # container registration guard
./container/build.sh                                              # agent image
```

All four must be clean before proceeding. Each guards a distinct integration point:

- **`src/providers/opencode-registration.test.ts`** (host, vitest) imports the real host barrel (`./index.js` → `listProviderContainerConfigNames`) and asserts `opencode` is present. It goes red if the `import './opencode.js';` line in `src/providers/index.ts` is deleted or drifts, or if that barrel fails to evaluate.
- **`container/agent-runner/src/providers/opencode-registration.test.ts`** (container, bun:test) imports the real container barrel (`./index.js` → `listProviderNames`) and asserts `opencode` is present. It goes red if the `import './opencode.js';` line in `container/agent-runner/src/providers/index.ts` is deleted or drifts. Because the barrel is imported unmocked, it also pulls in `opencode.ts`, which imports **`@opencode-ai/sdk`** — so this test implicitly guards the step-4 dependency too: if the package isn't installed, the import throws and the test goes red.
- **`src/opencode-dockerfile.test.ts`** parses `container/Dockerfile` and asserts both the `ARG OPENCODE_VERSION=...` (rejecting `latest`) and the `pnpm install -g "opencode-ai@${OPENCODE_VERSION}"` line are present. The `opencode-ai` CLI binary is not importable, so it is guarded by this structural test plus the container build — not the registration test.
- **`pnpm run build`** type-checks the host provider's consumption of the host-side container-config registry; the container typecheck does the same for the container provider against the agent-runner core APIs.

The pre-existing `opencode.factory.test.ts` imports `opencode.ts` directly and self-registers, so it stays green even if a barrel import is removed — it is a unit test of `createProvider('opencode')`, not the registration guard. Keep it; it adds factory coverage but does not stand in for the registration tests above.

> **Build cache gotcha:** The container buildkit caches COPY steps aggressively. If provider files were already present in the build context before, the new files may not be picked up. If you see "Unknown provider: opencode" after the build, prune the builder and rebuild:
> ```bash
> docker builder prune -f && ./container/build.sh
> ```

### 8. Propagate to existing per-group overlays

Each agent group has a live source overlay at `data/v2-sessions/<group-id>/agent-runner-src/providers/` that **overrides the image at runtime**. This overlay is created when the group is first wired and never auto-updated by image rebuilds. Any group that already existed before this skill ran needs the new files copied in manually.

```bash
for overlay in data/v2-sessions/*/agent-runner-src/providers/; do
  [ -d "$overlay" ] || continue
  cp container/agent-runner/src/providers/opencode.ts "$overlay"
  cp container/agent-runner/src/providers/mcp-to-opencode.ts "$overlay"
  cp container/agent-runner/src/providers/index.ts "$overlay"
  echo "Updated: $overlay"
done
```

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
- **`NO_PROXY`** for localhost matters when the OpenCode client talks to `127.0.0.1` inside the container while HTTP(S)_PROXY is set (e.g. OneCLI).

## Next Steps

The registration and Dockerfile guards in step 7 verify the wiring. To confirm an end-to-end round-trip, switch a test group with `ncl groups config update --id <group-id> --provider opencode && ncl groups restart --id <group-id>`, register the matching provider key in OneCLI, and send a message. A clean exchange returns the model's reply with no `Unknown provider: opencode` error and no UUID/session warnings in the logs.

To remove this provider, see [REMOVE.md](REMOVE.md).
