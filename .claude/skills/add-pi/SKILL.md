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

Also check the **auth template** the host seeds from (fix before continuing if missing):

```bash
ls ~/.pi/agent/auth.json 2>/dev/null || echo "MISSING: run pi once on the host (/login), or set PI_TEMPLATE_AGENT_DIR to a populated agentDir"
```

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

**The official path is the `ncl` CLI** — it updates both sides of the provider split in one command:

```bash
pnpm exec tsx src/cli/client.ts groups config update --provider pi --id <agent-group-id>
pnpm exec tsx src/cli/client.ts groups restart --id <agent-group-id>   # changes take effect on restart
```

Why both sides matter — v2 keeps the provider in **two places**:

- **`container_configs.provider`** (DB) → the host materializes `groups/<folder>/container.json` from it at every spawn (`materializeContainerJson()`), and the in-container runner reads `provider` from that file. **This is what the agent actually runs.**
- **`agent_groups.agent_provider`** (DB) → drives host-side provider contribution only (for pi: the `/pi-agent` mount and `PI_AGENT_DIR` env).

`ncl groups config update --provider` writes both. If you edit tables by hand instead, update **both** — flipping only `agent_groups` (or only `container.json`) leaves the runner launching the wrong provider: the failure signature is a first reply of `"The agent run failed"` with `continuation:claude` in the session's `outbound.db` `session_state` table (see **Verify**). The host-side resolver falls back through session → group → `'claude'`.

Extra MCP servers still come from **`NANOCLAW_MCP_SERVERS`** / `container_config.mcpServers` on the host; the runner merges them into the same `mcpServers` object the bridge consumes. stdio servers are spawned in process by the bridge (native `cwd` support — no shim); http servers speak **Streamable HTTP** only (no legacy SSE fallback).

## Operational notes

- The continuation token is the **absolute path of the pi session file** under `<workspace>/.pi/sessions` — it survives container restarts because the workspace is the RW volume. `/clear` works as usual (fresh session next turn).
- A resumed session whose first turn produces no assistant work and no error is treated as a dead continuation: one automatic fresh-session fallback per query, with the original prompt replayed and a second `init` persisted.
- **abort()** tears down in process (`session.abort()` + dispose) — there is no serve process tree to SIGKILL. Mid-turn `push()` rides pi's native follow-up queue.
- Memory hook runs on new-session openings only, fail-closed (a failed hook logs and skips injection, never kills the turn). pi compacts in place, so there is no post-compaction re-arm step.
- Slash commands stay XML-wrapped by the runner (`supportsNativeSlashCommands = false`): pi's native commands (/compact, /theme, …) are interactive-TUI semantics and unwanted headless.

### Fresh-install path (setup and pi)

On a machine where setup has not run yet:

- **The setup provider picker lives in the `auth` step and does not list pi** — that picker is for runtimes with their own auth flow. pi needs none (credentials come from the agentDir template). Complete setup with the default Claude pick or skip the step; you do **not** need an Anthropic login for pi.
- **Do not skip the `onecli` step.** The OneCLI local vault is a spawn prerequisite regardless of provider: without it, every container spawn fails with `OneCLIRequestError 401` (against `api.onecli.sh`) and messages accumulate undelivered. If you skipped it during setup: `pnpm exec tsx setup/index.ts --step onecli`.
- The setup epilogue warning *"Your Claude account isn't connected"* is expected on a pi-only install — pi never reads Anthropic credentials.
- Then switch the group(s) to pi as in **Per group / per session** above.

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

End-to-end check (the definitive one) — with the host service running and a group switched to pi:

```bash
pnpm run chat "reply with exactly: PI_E2E_OK"        # Terminal Agent via the cli channel

# Then confirm pi actually ran that turn — not just that a reply came back:
node -e '
const D = require("better-sqlite3");
const dir = require("fs").readdirSync("data/v2-sessions/<agent-group-id>");
// pick the newest session dir, open its outbound.db, read session_state keys
' # → must contain  "continuation:pi"
```

`continuation:pi` in the session's `outbound.db` → `session_state` table is the ground truth: the poll-loop keys continuations by provider name, so this row proves the pi provider executed the turn. A healthy first reply takes **~15s including container cold start** — a long pause there is normal, not a hang.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| First reply is `"The agent run failed. Check the logs."`; `outbound.db` `session_state` shows `continuation:claude` | Provider switch never reached `container_configs` — the runner defaulted to claude (no Anthropic auth → fail) | `ncl groups config update --provider pi --id <group>` + `ncl groups restart --id <group>`; see **Per group / per session** |
| Spawns fail with `OneCLIRequestError … api.onecli.sh … 401` | The `onecli` setup step was skipped — the local vault is a spawn prerequisite for every provider | `pnpm exec tsx setup/index.ts --step onecli`, then restart the service |
| Setup epilogue: *"Your Claude account isn't connected"* | Expected on pi-only installs — pi reads no Anthropic credentials | None; ignore |
| `pnpm install` fails compiling `better-sqlite3` (`make: *** better_sqlite3.o 错误 1`, Node 26 ABI) | The pinned better-sqlite3 predates your Node's ABI (host env issue, not pi-specific) | Use Node 22 LTS (matches the agent image); upstream tracks newer-Node fixes on `fix/better-sqlite3-node24` |
| `docker build`: `the --mount option requires BuildKit` | Docker CLI lacks the buildx plugin (common on Docker 27+ without desktop) | `mkdir -p ~/.docker/cli-plugins && curl -L https://github.com/docker/buildx/releases/download/v0.37.1/buildx-v0.37.1.linux-amd64 -o ~/.docker/cli-plugins/docker-buildx && chmod +x ~/.docker/cli-plugins/docker-buildx` |
| Every pi turn fails with a model-auth error; container logs show pi found no `auth.json` | Template dir missing/empty (no `~/.pi/agent`), so seeding copied nothing | Run pi once on the host (`/login`), or point `PI_TEMPLATE_AGENT_DIR` at a populated agentDir; then delete the session's `pi-agent` dir to force a reseed |
