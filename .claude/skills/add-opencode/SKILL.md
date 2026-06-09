---
name: add-opencode
description: Use OpenCode as an agent provider (AGENT_PROVIDER=opencode). OpenRouter, OpenAI, Google, DeepSeek, etc. via OpenCode config — not the Anthropic Agent SDK. Per-session and per-group via agent_provider; host passes OPENCODE_* and XDG mount when spawning containers.
---

# OpenCode agent provider

NanoClaw runs agents in a long-lived **poll loop** inside the container. The backend is selected with **`AGENT_PROVIDER`** (`claude` | `opencode` | `mock`).

Trunk ships with only the `claude` provider baked in. This skill copies the OpenCode provider files in from the `providers` branch, wires them into the host and container barrels, installs dependencies, and rebuilds the image.

## Install

### Pre-flight

If all of the following are already present, skip to **Configuration**:

- `src/providers/opencode.ts`
- `container/agent-runner/src/providers/opencode.ts`
- `container/agent-runner/src/providers/skill-catalog.ts` (shared with `/add-codex`)
- `import './opencode.js';` line in `src/providers/index.ts`
- `import './opencode.js';` line in `container/agent-runner/src/providers/index.ts`
- `@opencode-ai/sdk` in `container/agent-runner/package.json`
- `opencode-ai@${OPENCODE_VERSION}` in the pnpm global-install block in `container/Dockerfile`

Missing pieces — continue below. All steps are idempotent; re-running is safe.

### 1. Fetch the providers branch

```bash
git fetch origin providers
```

### 2. Copy the OpenCode source files

Wholesale copies (owned entirely by this skill — user edits to these files won't survive a re-run, as designed):

```bash
git show origin/providers:src/providers/opencode.ts                                    > src/providers/opencode.ts
git show origin/providers:container/agent-runner/src/providers/opencode.ts             > container/agent-runner/src/providers/opencode.ts
git show origin/providers:container/agent-runner/src/providers/mcp-to-opencode.ts      > container/agent-runner/src/providers/mcp-to-opencode.ts
git show origin/providers:container/agent-runner/src/providers/mcp-to-opencode.test.ts > container/agent-runner/src/providers/mcp-to-opencode.test.ts
git show origin/providers:container/agent-runner/src/providers/opencode.factory.test.ts > container/agent-runner/src/providers/opencode.factory.test.ts
git show origin/providers:container/agent-runner/src/providers/skill-catalog.ts        > container/agent-runner/src/providers/skill-catalog.ts
git show origin/providers:container/agent-runner/src/providers/skill-catalog.test.ts   > container/agent-runner/src/providers/skill-catalog.test.ts
```

`skill-catalog.ts` is a small shared helper used by every non-Claude provider (it builds a discovery list of installed Claude Code skills so Codex / OpenCode / etc. can `Read` and follow them). Idempotent — if `/add-codex` already copied it, this just rewrites the identical bytes.

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

**(a)** In the "Pin CLI versions" ARG block (around line 18), add after `ARG VERCEL_VERSION=latest`:

```dockerfile
ARG OPENCODE_VERSION=1.4.17
```

> **Do not use `latest`** — the CLI and SDK must be the same version. `latest` silently upgrades the CLI to 1.14.x which has a breaking session API change (UUID session IDs → `ses_` prefix) incompatible with SDK 1.4.x.

**(b)** In the `pnpm install -g` block (around line 80), append `"opencode-ai@${OPENCODE_VERSION}"` to the list:

```dockerfile
    pnpm install -g \
        "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
        "agent-browser@${AGENT_BROWSER_VERSION}" \
        "vercel@${VERCEL_VERSION}" \
        "opencode-ai@${OPENCODE_VERSION}"
```

### 6. Build

```bash
pnpm run build                                         # host
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit   # container typecheck
./container/build.sh                                   # agent image
```

> **Build cache gotcha:** The container buildkit caches COPY steps aggressively. If provider files were already present in the build context before, the new files may not be picked up. If you see "Unknown provider: opencode" after the build, prune the builder and rebuild:
> ```bash
> docker builder prune -f && ./container/build.sh
> ```

### 7. Propagate to existing per-group overlays

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

These variables are read **on the host** and passed into the container only when the effective provider is `opencode`. They do not switch the provider by themselves; the DB still needs `agent_provider` set (below).

- `OPENCODE_PROVIDER` — OpenCode provider id, e.g. `openrouter`, `anthropic`, `deepseek`.
- `OPENCODE_MODEL` — full model id in `provider/model` form, e.g. `deepseek/deepseek-chat`.
- `OPENCODE_SMALL_MODEL` — optional second model for lighter tasks; defaults to `OPENCODE_MODEL` if unset.
- `ANTHROPIC_BASE_URL` — **required for non-`anthropic` providers.** The opencode container provider passes this as the `baseURL` for the upstream provider config so requests route through OneCLI's credential proxy or directly to the provider's API. Set it to the provider's API base URL (e.g. `https://api.deepseek.com/v1`, `https://openrouter.ai/api/v1`).

Credentials: register provider API keys in OneCLI with the matching `--host-pattern` (e.g. `api.deepseek.com`, `openrouter.ai`). OneCLI injects them via `HTTPS_PROXY` in the container — the key never lives in `.env` or the container environment.

After adding a secret, **grant the agent access** — agents in `selective` mode only receive secrets they've been explicitly assigned:

```bash
# Find the agent id and secret id, then:
onecli agents set-secrets --id <agent-id> --secret-ids <existing-ids>,<new-secret-id>
```

Always include existing secret IDs in the list — `set-secrets` replaces, not appends.

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

**Naming:** NanoClaw **`AGENT_PROVIDER=opencode`** (DB `agent_provider`) means "run the **OpenCode agent provider**." Separately, **`OPENCODE_PROVIDER=opencode`** in `.env` is OpenCode's **Zen provider id** inside the OpenCode config (see [Zen docs](https://opencode.ai/docs/zen/)).

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

### Per group / per session

Set `"provider": "opencode"` in the group's **`container.json`** (`groups/<folder>/container.json`) — the in-container runner reads `provider` from there, not from the DB. The DB columns **`agent_groups.agent_provider`** and **`sessions.agent_provider`** (session overrides group) only drive host-side provider contribution — per-session XDG mount, `OPENCODE_*` env passthrough — and do not propagate into `container.json` at spawn time. Set both, or just edit `container.json`; if they disagree, the runner uses `container.json` and the host-side resolver falls back through session → group → `container.json` → `'claude'`.

Extra MCP servers still come from **`NANOCLAW_MCP_SERVERS`** / `container_config.mcpServers` on the host; the runner merges them into the same `mcpServers` object passed to **both** Claude and OpenCode providers.

## Operational notes

- OpenCode keeps a local **`opencode serve`** process and SSE subscription; the provider tears down with **`stream.return`** and **SIGKILL** on the server process on **`abort()`** / shared runtime reset to avoid MCP/zombie hangs.
- Session continuation uses UUID format (SDK 1.4.x / CLI 1.4.x). Stale sessions are cleared by `isSessionInvalid` on OpenCode-specific error patterns. If you see UUID-related errors after an accidental CLI upgrade, clear `session_state` in `outbound.db` and wipe the `opencode-xdg` directory under the session folder.
- **`NO_PROXY`** for localhost matters when the OpenCode client talks to `127.0.0.1` inside the container while HTTP(S)_PROXY is set (e.g. OneCLI).

## Verify

```bash
grep -q "./opencode.js" container/agent-runner/src/providers/index.ts && echo "container barrel: OK"
grep -q "./opencode.js" src/providers/index.ts && echo "host barrel: OK"
grep -q "@opencode-ai/sdk" container/agent-runner/package.json && echo "agent-runner dep: OK"
grep -q "opencode-ai@" container/Dockerfile && echo "Dockerfile install: OK"
cd container/agent-runner && bun test src/providers/ && cd -
```
