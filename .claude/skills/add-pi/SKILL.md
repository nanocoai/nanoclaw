---
name: add-pi
description: Use pi as an agent provider (AGENT_PROVIDER=pi). In-process Pi Coding Agent SDK inside the container — no serve process, no global CLI. Models and auth come from a per-session seeded pi agentDir (auth.json/models.json/settings.json); per-session and per-group via agent_provider; host mounts the agentDir and passes PI_AGENT_DIR.
---

# pi agent provider

NanoClaw runs agents in a long-lived **poll loop** inside the container. The backend is selected with **`AGENT_PROVIDER`** (`claude` | `opencode` | `codex` | `pi` | `mock`).

pi is an **in-process SDK** provider: the container runner embeds `@earendil-works/pi-coding-agent` directly. There is no `pi serve` process, no SSE subscription, no global CLI install — unlike OpenCode, the whole complexity class of server lifecycle management does not exist here. MCP servers are bridged to pi `customTools` in process (`mcp-to-pi.ts`).

Auth model: pi resolves models and credentials **exclusively from its agentDir files** — the SDK reads no environment variables for auth. The host-side provider config seeds `auth.json` / `models.json` / `settings.json` from a host template directory into a per-session directory mounted at `/pi-agent`, and the container provider points pi at it via `PI_AGENT_DIR`.

This skill copies the pi provider files in from the `providers` branch, wires them into the host and container barrels, installs the SDK dependency, and rebuilds the image.

## Install

### Pre-flight

If all of the following are already present, skip to **Configuration**:

- `src/providers/pi.ts` (host-side container config with the seeding logic)
- `container/agent-runner/src/providers/pi.ts`
- `container/agent-runner/src/providers/mcp-to-pi.ts`
- `container/agent-runner/src/provider-contracts/pi.ts`
- `container/agent-runner/src/providers/pi-registration.test.ts`
- `container/agent-runner/src/providers/pi.factory.test.ts`
- `container/agent-runner/src/providers/mcp-to-pi.test.ts`
- `import './pi.js';` line in `src/providers/index.ts`
- `import './pi.js';` line in `container/agent-runner/src/providers/index.ts`
- `@earendil-works/pi-coding-agent` in `container/agent-runner/package.json`

Missing pieces — continue below. All steps are idempotent; re-running is safe.

### 1. Fetch the branch that carries the pi payload

```bash
git fetch origin providers
PI_REF=origin/providers
```

> If the pi PR has not merged yet, point `PI_REF` at a ref that carries the payload (the feature branch, e.g. `PI_REF=pi-provider`). If your worktree **already contains all payload files** — e.g. you are on the pi feature branch itself — skip step 2 entirely: the worktree copies are authoritative and may be newer than any pushed ref.

### 2. Copy the pi source files

Wholesale copies (owned entirely by this skill — user edits to these files won't survive a re-run, as designed):

```bash
git show $PI_REF:container/agent-runner/src/providers/pi.ts                    > container/agent-runner/src/providers/pi.ts
git show $PI_REF:container/agent-runner/src/providers/mcp-to-pi.ts             > container/agent-runner/src/providers/mcp-to-pi.ts
git show $PI_REF:container/agent-runner/src/providers/pi-registration.test.ts  > container/agent-runner/src/providers/pi-registration.test.ts
git show $PI_REF:container/agent-runner/src/providers/pi.factory.test.ts       > container/agent-runner/src/providers/pi.factory.test.ts
git show $PI_REF:container/agent-runner/src/providers/mcp-to-pi.test.ts        > container/agent-runner/src/providers/mcp-to-pi.test.ts
git show $PI_REF:container/agent-runner/src/provider-contracts/pi.ts           > container/agent-runner/src/provider-contracts/pi.ts
git show $PI_REF:src/providers/pi.ts                                           > src/providers/pi.ts
```

> Unlike the OpenCode skill, no shared trunk file is touched here, so there is no `.new` + `mv` guard. pi needs no `cwd-shim`: the MCP SDK's stdio transport has a native spawn-directory field, so `mcp-to-pi.ts` passes `cwd` through directly.

> **Ref-version sanity check.** The container provider and the host config are a **pair**: the host mounts a seeded agentDir at `/pi-agent` and sets `PI_AGENT_DIR`, and the container side reads it. If `$PI_REF` predates the host-seeding change, the copies still compile but auth seeding silently never happens. Verify both halves:

```bash
grep -q PI_AGENT_DIR container/agent-runner/src/providers/pi.ts \
  && grep -q seedFromTemplate src/providers/pi.ts \
  && echo "payload pair: OK" \
  || echo "STALE REF — copy from a worktree that has both files"
```

### 3. Append the self-registration imports

Each barrel gets one line appended at the end — skip if the line is already present.

`src/providers/index.ts` (host — pi **does** need host-side setup, unlike claude/mock: it mounts the agentDir and passes `PI_AGENT_DIR`):

```typescript
import './pi.js';
```

`container/agent-runner/src/providers/index.ts` (container):

```typescript
import './pi.js';
```

**Main-based trees only** (skip if the file does not exist — stock `providers`-branch payloads don't have it): `container/agent-runner/src/provider-contracts/index.ts` gets the contract import next to the line above:

```typescript
import './pi.js';
```

The contract file is a donor file: on trees without the contract core it is never imported and simply sits there (it will show donor-mode tsc errors — expected, see step 6).

### 4. Add the agent-runner dependency

Pinned. Bump deliberately, not with `bun update`. Use `0.85.1` — the provider code is written and tested against the 0.85.x SDK surface.

```bash
cd container/agent-runner && bun add @earendil-works/pi-coding-agent@0.85.1 && cd -
```

> **Do not use `latest`.** The lesson from the OpenCode skill applies: a floating pin silently pulls an incompatible SDK. The MCP bridge (`mcp-to-pi.ts`) uses `@modelcontextprotocol/sdk`, which is **already** an agent-runner dependency — no extra install for it.

### 5. Dockerfile — no changes required

pi is a pure SDK dependency of the agent-runner. There is no global CLI to pin (no `ARG PI_VERSION` + `pnpm install -g` block like the OpenCode skill's step 5), no serve process to have on PATH, and no XDG state directory baked into the image. `bun install` during the image build picks up `@earendil-works/pi-coding-agent` from `package.json`. Do nothing here.

### 6. Build

```bash
pnpm run build                                         # host
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit   # container typecheck
./container/build.sh                                   # agent image
```

> **Pre-existing tsc errors are the baseline — the bar is "no new errors."** The `providers` branch is a payload branch and does not typecheck clean at HEAD: donor files under `provider-contracts/` import a `./registry.js` that only exists on main-based trees, and `codex`/`opencode` account for the stock errors. After this skill, `provider-contracts/pi.ts` adds exactly the **same two donor-mode errors** the codex/opencode contracts have (missing `registerProviderContract` export + missing `./registry.js`), and `providers/pi.ts`, `mcp-to-pi.ts`, and `src/providers/pi.ts` add **zero**. Any tsc error inside a pi file beyond those two known ones means the copied payload is stale or drifted.

> **Build cache gotcha:** the container buildkit caches COPY steps aggressively. If provider files were already present in the build context before, the new files may not be picked up. If you see "Unknown provider: pi" after the build, prune the builder and rebuild:
> ```bash
> docker builder prune -f && ./container/build.sh
> ```

### 7. Propagate to existing per-group overlays

Each agent group has a live source overlay at `data/v2-sessions/<group-id>/agent-runner-src/providers/` that **overrides the image at runtime**. This overlay is created when the group is first wired and never auto-updated by image rebuilds. Any group that already existed before this skill ran needs the new files copied in manually.

```bash
for overlay in data/v2-sessions/*/agent-runner-src/providers/; do
  [ -d "$overlay" ] || continue
  cp container/agent-runner/src/providers/pi.ts "$overlay"
  cp container/agent-runner/src/providers/mcp-to-pi.ts "$overlay"
  cp container/agent-runner/src/providers/index.ts "$overlay"
  echo "Updated: $overlay"
done
```

(`provider-contracts/pi.ts` is a donor file for main-based trees; the runtime overlay carries only the `providers/` directory, same as the OpenCode skill.)

## Configuration

### pi agentDir (required)

pi reads no credentials from environment variables — put them where pi looks for them:

- **Template directory:** `~/.pi/agent` on the host (override with `PI_TEMPLATE_AGENT_DIR`). This is a normal pi agentDir — the easiest way to populate it is to run pi once interactively on the host, or copy the directory from a machine where pi already works. The three files that get seeded:
  - `auth.json` — provider credentials
  - `models.json` — custom model definitions (optional)
  - `settings.json` — default model and other settings (optional)
- **Seeding:** on the first spawn of each session, the host provider config copies these files into `<session-dir>/pi-agent/` (existing files are never overwritten), mounts that directory at `/pi-agent` (read-write), and sets `PI_AGENT_DIR=/pi-agent` in the container.
- **Credential rotation:** edit the template, then delete the session's `pi-agent` directory — the next spawn reseeds it. No image rebuild needed. Session transcripts are **not** stored here (the container keeps them under `<workspace>/.pi/sessions`), so removing the directory never loses conversation history.

> ⚠️ **Credentials are plaintext files** — on the host and, via the mount, visible inside the container. `chmod 600` the template's `auth.json`.

> ⚠️ **OneCLI does not apply to pi yet.** pi never reads auth headers from env, so the OneCLI placeholder + HTTPS_PROXY injection pattern (claude/opencode) has nothing to hook into. Real credentials in the agentDir files is the current mechanism. Aligning pi with OneCLI credential proxying is future work.

### Host `.env`

Unlike OpenCode, there are **no `PI_*` model/env knobs** — model selection lives in the agentDir files (`settings.json` / `models.json`). The only host variable this skill introduces is the optional template override:

```env
# Optional: where to seed auth.json/models.json/settings.json from (default ~/.pi/agent)
#PI_TEMPLATE_AGENT_DIR=/path/to/template-agent-dir
```

`ANTHROPIC_BASE_URL` and friends are not used by the pi provider.

### Per group / per session

Set `"provider": "pi"` in the group's **`container.json`** (`groups/<folder>/container.json`) — the in-container runner reads `provider` from there, not from the DB. The DB columns **`agent_groups.agent_provider`** and **`sessions.agent_provider`** (session overrides group) only drive host-side provider contribution — for pi that is the `/pi-agent` mount and the `PI_AGENT_DIR` env — and do not propagate into `container.json` at spawn time. The host-side resolver falls back through session → group → `container.json` → `'claude'`.

> ⚠️ For pi the split matters more than for OpenCode: if you only edit `container.json` and leave the DB at the default, the container spawns with the pi runner but **without** `PI_AGENT_DIR` — pi then falls back to `<cwd>/.pi/agent` inside the workspace, finds no `auth.json` there, and every turn fails with a model-auth error. Set the DB columns too (or accept the fallback and seed `<cwd>/.pi/agent` yourself).

Extra MCP servers still come from **`NANOCLAW_MCP_SERVERS`** / `container_config.mcpServers` on the host; the runner merges them into the same `mcpServers` object the bridge consumes. stdio servers are spawned in process by the bridge (native `cwd` support — no shim); http servers speak **Streamable HTTP** only (no legacy SSE fallback).

## Operational notes

- The continuation token is the **absolute path of the pi session file** under `<workspace>/.pi/sessions` — it survives container restarts because the workspace is the RW volume. `/clear` works as usual (fresh session next turn).
- A resumed session whose first turn produces no assistant work and no error is treated as a dead continuation: one automatic fresh-session fallback per query, with the original prompt replayed and a second `init` persisted.
- **abort()** tears down in process (`session.abort()` + dispose) — there is no serve process tree to SIGKILL. Mid-turn `push()` rides pi's native follow-up queue.
- Memory hook runs on new-session openings only, fail-closed (a failed hook logs and skips injection, never kills the turn). pi compacts in place, so there is no post-compaction re-arm step.
- Slash commands stay XML-wrapped by the runner (`supportsNativeSlashCommands = false`): pi's native commands (/compact, /theme, …) are interactive-TUI semantics and unwanted headless.

## Verify

```bash
grep -q "./pi.js" container/agent-runner/src/providers/index.ts && echo "container barrel: OK"
grep -q "./pi.js" src/providers/index.ts && echo "host barrel: OK"
grep -q "@earendil-works/pi-coding-agent" container/agent-runner/package.json && echo "agent-runner dep: OK"
grep -q PI_AGENT_DIR container/agent-runner/src/providers/pi.ts && grep -q seedFromTemplate src/providers/pi.ts && echo "host/container pair: OK"
cd container/agent-runner && bun test src/providers/ && cd -
```

The pi test files add 24 tests (registration via the real barrel, factory construction, MCP bridge mapping incl. an in-memory end-to-end transport). All green means the barrel wiring and the dependency are correct.

Manual smoke — construct the provider without touching the network:

```bash
cd container/agent-runner && bun -e 'await import("./src/providers/pi.js"); const { createProvider } = await import("./src/providers/factory.js"); console.log("pi provider constructs:", createProvider("pi").constructor.name);' && cd -
```

Expected output: `pi provider constructs: PiProvider`. A first end-to-end turn then requires a seeded agentDir (see **Configuration** above) with working credentials for the model named in `settings.json`.
