---
name: add-codex
description: Use Codex (CLI + AppServer) as the full agent provider — planning, tool orchestration, native compaction, MCP tools, session resume — in place of the Claude Agent SDK. ChatGPT subscription or OPENAI_API_KEY. Per-group via agent_provider. Distinct from using OpenAI as an MCP tool (where Claude remains the planner).
---

# Codex agent provider

NanoClaw runs agents in a long-lived **poll loop** inside the container. The backend is selected with **`AGENT_PROVIDER`** (`claude` | `opencode` | `codex` | `mock`).

Trunk ships with only the `claude` provider baked in. This skill copies the Codex provider files in from the `providers` branch, wires them into the host and container barrels, updates the Dockerfile to install the Codex CLI, and rebuilds the image.

The Codex provider runs `codex app-server` as a child process and speaks JSON-RPC over stdio. That gives it native session resume, streaming events, MCP tool access, and `thread/compact/start` compaction — same feature bar as the Claude Agent SDK, without the Anthropic-only lock-in.

## Install

### Pre-flight

If all of the following are already present, skip to **Configuration**:

- `src/providers/codex.ts`
- `container/agent-runner/src/providers/codex.ts`
- `container/agent-runner/src/providers/codex-app-server.ts`
- `container/agent-runner/src/providers/codex.factory.test.ts`
- `container/agent-runner/src/providers/skill-catalog.ts` (shared with `/add-opencode`)
- `import './codex.js';` line in `src/providers/index.ts`
- `import './codex.js';` line in `container/agent-runner/src/providers/index.ts`
- `ARG CODEX_VERSION` and `"@openai/codex@${CODEX_VERSION}"` in the pnpm global-install block in `container/Dockerfile`

Missing pieces — continue below. All steps are idempotent; re-running is safe.

### 1. Fetch the providers branch

```bash
git fetch origin providers
```

### 2. Copy the Codex source files

Wholesale copies (owned entirely by this skill — user edits to these files won't survive a re-run, as designed):

```bash
git show origin/providers:src/providers/codex.ts                                      > src/providers/codex.ts
git show origin/providers:container/agent-runner/src/providers/codex.ts               > container/agent-runner/src/providers/codex.ts
git show origin/providers:container/agent-runner/src/providers/codex-app-server.ts    > container/agent-runner/src/providers/codex-app-server.ts
git show origin/providers:container/agent-runner/src/providers/codex.factory.test.ts  > container/agent-runner/src/providers/codex.factory.test.ts
git show origin/providers:container/agent-runner/src/providers/skill-catalog.ts       > container/agent-runner/src/providers/skill-catalog.ts
git show origin/providers:container/agent-runner/src/providers/skill-catalog.test.ts  > container/agent-runner/src/providers/skill-catalog.test.ts
```

`skill-catalog.ts` is a small shared helper used by every non-Claude provider (it builds a discovery list of installed Claude Code skills so Codex / OpenCode / etc. can `Read` and follow them). Idempotent — if `/add-opencode` already copied it, this just rewrites the identical bytes.

### 3. Append the self-registration imports

Each barrel gets one line — alphabetical placement keeps diffs small.

`src/providers/index.ts`:

```typescript
import './codex.js';
```

`container/agent-runner/src/providers/index.ts`:

```typescript
import './codex.js';
```

### 4. Add the Codex CLI to the container Dockerfile

Two edits to `container/Dockerfile`, both idempotent (skip if already present):

**(a)** In the "Pin CLI versions" ARG block (around line 18), add after `ARG CLAUDE_CODE_VERSION=...`:

```dockerfile
ARG CODEX_VERSION=0.124.0
```

**(b)** Add a new standalone `RUN` block for the Codex CLI, after the existing per-CLI install blocks (around line 106, right after the `@anthropic-ai/claude-code` block). The Dockerfile splits each global CLI into its own layer for cache granularity — keep that pattern; do not collapse them into a single combined `pnpm install -g` call:

```dockerfile
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "@openai/codex@${CODEX_VERSION}"
```

Note: **no agent-runner package dependency** — Codex is a CLI binary, not a library. Unlike OpenCode, there's nothing to add to `container/agent-runner/package.json`.

### 5. Build

```bash
pnpm run build                                         # host
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit   # container typecheck
./container/build.sh                                   # agent image
```

## Configuration

Codex supports two primary auth paths and one experimental BYO-endpoint path. Pick the one that matches your setup.

### Option A — ChatGPT subscription (recommended for individuals)

On the host (not inside the container), run Codex's OAuth login:

```bash
codex login
```

This writes `~/.codex/auth.json` with a subscription token. The host-side Codex provider ([src/providers/codex.ts](../../../src/providers/codex.ts)) copies `auth.json` into a per-session `~/.codex` directory mounted into the container — your host's own Codex CLI is never touched.

No `.env` variables required for this mode.

### Option B — API key (recommended for CI or API billing)

```env
OPENAI_API_KEY=sk-...
CODEX_MODEL=gpt-5.4-mini
```

The host forwards both variables into the container. If both subscription (`auth.json`) and `OPENAI_API_KEY` are present, Codex prefers the subscription.

### Option C — BYO OpenAI-compatible endpoint (experimental)

Codex's built-in `openai` provider honors the `OPENAI_BASE_URL` env var directly. Point it at any OpenAI-compatible endpoint — Groq, Together, self-hosted vLLM, an OpenAI proxy, etc.

```env
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.groq.com/openai/v1
CODEX_MODEL=llama-3.3-70b-versatile
```

Codex also ships first-class local-runner flags — `codex --oss --local-provider ollama` or `--local-provider lmstudio` — that auto-detect a local server. To use those inside NanoClaw, set `CODEX_MODEL` to a model your local runner serves and add the corresponding base URL; see the Codex CLI docs for the full `model_provider = oss` configuration.

**Experimental caveat:** tool-calling quality depends on the model and endpoint. Not every OpenAI-compat provider implements the full function-calling spec, and smaller models (< 30B) often struggle with multi-step tool orchestration. Test before committing.

### Per group / per session

Set `"provider": "codex"` in the group's **`container.json`** (`groups/<folder>/container.json`) — the in-container runner reads `provider` from there, not from the DB. The DB columns **`agent_groups.agent_provider`** and **`sessions.agent_provider`** (session overrides group) only drive host-side provider contribution — per-session `~/.codex` mount, `OPENAI_*` / `CODEX_MODEL` env passthrough — and do not propagate into `container.json` at spawn time. Set both, or just edit `container.json`; if they disagree, the runner uses `container.json` and the host-side resolver falls back through session → group → `container.json` → `'claude'`.

`CODEX_MODEL` applies process-wide via `.env`; if you need different models for different groups, set them via `container_config.env` on the group.

Extra MCP servers still come from **`NANOCLAW_MCP_SERVERS`** / `container_config.mcpServers` on the host. The runner merges them into the same `mcpServers` object passed to all providers.

## Operational notes

- **Spawn-per-query:** Codex's app-server is spawned fresh per query invocation, matching the OpenCode pattern. No long-lived daemon to keep healthy across sessions.
- **Per-session `~/.codex` isolation:** each group gets its own copy of the host's `auth.json`. The container can rewrite `config.toml` freely on every wake without touching the host's Codex config.
- **Native compaction:** kicks in automatically at 40K cumulative input tokens between turns, via `thread/compact/start`. If compaction fails, the provider logs and continues uncompacted — no fatal error.
- **Approvals:** auto-accepted inside the container (the container is the sandbox; same posture as Claude/OpenCode).
- **Mid-turn input:** Codex turns don't accept mid-turn messages. Follow-up `push()` calls queue and drain between turns, matching the OpenCode pattern. The poll-loop only pushes between turns anyway, so no messages are dropped.
- **Stale thread recovery:** `isSessionInvalid` matches on stale-thread-ID errors (`thread not found`, `unknown thread`, etc.) so a cold-started app-server can recover cleanly when it sees a stored continuation it no longer has.

## Verify

```bash
grep -q "./codex.js" container/agent-runner/src/providers/index.ts && echo "container barrel: OK"
grep -q "./codex.js" src/providers/index.ts && echo "host barrel: OK"
grep -q "@openai/codex@" container/Dockerfile && echo "Dockerfile install: OK"
cd container/agent-runner && bun test src/providers/codex.factory.test.ts && cd -
```

After the image rebuild, set `agent_provider = 'codex'` on a test group and send a message. Successful round-trip looks like:

- `init` event with a stable thread ID as continuation
- One or more `activity` / `progress` events during the turn
- `result` event with the model's reply

If the agent hangs or errors, check `~/.codex/auth.json` exists on the host (Option A) or that `OPENAI_API_KEY` is forwarding correctly (Option B) — `docker exec` into a running container and `env | grep -i openai` to confirm.
