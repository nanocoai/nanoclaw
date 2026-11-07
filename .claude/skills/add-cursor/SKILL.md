---
name: add-cursor
description: Use Cursor (local Agent SDK) as a full agent provider — planning, tool orchestration, MCP tools, session resume — alongside or instead of Claude. Cursor-account sign-in or API key, held by the credential gateway. Per-group via `ncl groups config update --provider cursor`. Distinct from using Cursor as a cloud agent (those run on Cursor VMs and are not this provider).
metadata:
  nanoclaw-provider: cursor
  nanoclaw-provider-label: Cursor
  nanoclaw-provider-hint: Cursor — account sign-in or API key
  nanoclaw-provider-offered: 'true'
  nanoclaw-provider-image: local-required
---

# Cursor agent provider

> Shortcut: `pnpm exec tsx setup/index.ts --step provider-auth cursor` performs this whole install (payload files, barrels, SDK pin, image rebuild) plus auth in one command. The steps below are the same operations, for agent-driven or manual application.

NanoClaw selects each group's agent backend from `container_configs.provider` (default `claude`). This skill installs the Cursor provider: copy the payload from this skill's `payload/`, append one import to each of the five provider and contract barrels, pin `@cursor/sdk` in the agent-runner tree, rebuild, then run the auth walk-through.

The provider runs `@cursor/sdk` in-process inside the container (`Agent.create` / `resume` / `send`): native streaming, MCP tools, a local agent store (the continuation is a Cursor `agentId`). It integrates through the provider contracts only — a data-only host contract declares the composed `AGENTS.md`, the per-group `.cursor-shared` state volume at `~/.cursor`, the two Cursor-native skill directories and the Cursor model domains; the runtime contract declares the execution stance, model mapping, memory hooks, MCP mapping, and archives each exchange into `conversations/` through core's shared exchange archive.

Credentials stay in the credential gateway selected by `NANOCLAW_GATEWAY_PROVIDER`. The container only ever sees the placeholder `CURSOR_API_KEY=cursor_placeholder_nanoclaw`, which the SDK sends as a bearer header. Setup stores the key for two exact routes: `api2.cursor.sh/auth/exchange_user_api_key`, where the SDK swaps it for a short-lived runtime token, and `api.cursor.com/v1/models`, for model discovery. The runtime token stays in the SDK's memory and rides the same gateway proxy on the agent's Connect RPCs to `api2.cursor.sh`, which the gateway leaves untouched because the key is scoped to the exchange path. The payload ships `cursor.gateway-proxy.test.ts`, which proves every request of a real SDK run transits the proxy carrying nothing but the placeholder. Never put a key in chat.

The mechanical steps under **Install** carry `nc:` directive fences: an agent reads the prose and applies them, and a parser can apply them deterministically from the same document. Every directive is idempotent, so the whole skill is safe to re-run; anything a parser can't apply falls back to the prose beside it.

## Install

### Pre-flight

Install and refresh require host contract version 1, credential-connection seam version 2 or later (path-scoped credentials), and core's shared exchange archive (`container/agent-runner/src/provider-contracts/exchange-archive.ts`). The compatibility predicate below guards every later step, so an unsupported core receives no partial payload or dependency changes. If it prints `no`, stop and tell the operator to run `/update-nanoclaw` first.

```nc:run effect:refresh capture:cursor_core_ready validate:^yes$
node -e "const fs=require('fs'); const r=(f)=>fs.existsSync(f)?fs.readFileSync(f,'utf8'):''; if(/PROVIDER_HOST_CONTRACT_SEAM_VERSION = 1/.test(r('src/provider-contracts/registry.ts')) && /PROVIDER_CREDENTIAL_CONNECTION_SEAM_VERSION = ([2-9]|[1-9][0-9])/.test(r('setup/gateways/credential-store.ts')) && /export function archiveProviderExchange/.test(r('container/agent-runner/src/provider-contracts/exchange-archive.ts'))) console.log('yes'); else console.log('no')"
```

### 1. Copy the payload

Copy only the files listed below from this skill's `payload/` to the matching paths at the project root. These are skill-owned files; overwrite them together when refreshing the skill. The host files are the data-only host contract, the env adapter and their guards; the container files are the provider runtime (turn loop, event mapping, hooks.json writer), the runtime contract, the memory hook adapter, the host-side login helper, and their guards — including the conformance test the verifier requires and the gateway-proxy proof; the setup file is the picker entry and auth walk-through.

```nc:copy when:cursor_core_ready=yes
payload/src/providers/cursor.ts -> src/providers/cursor.ts
payload/src/providers/cursor-registration.test.ts -> src/providers/cursor-registration.test.ts
payload/src/providers/cursor-host-contribution.test.ts -> src/providers/cursor-host-contribution.test.ts
payload/src/provider-contracts/cursor.ts -> src/provider-contracts/cursor.ts
payload/container/agent-runner/src/providers/cursor.ts -> container/agent-runner/src/providers/cursor.ts
payload/container/agent-runner/src/providers/cursor-auth.ts -> container/agent-runner/src/providers/cursor-auth.ts
payload/container/agent-runner/src/providers/cursor-hook.ts -> container/agent-runner/src/providers/cursor-hook.ts
payload/container/agent-runner/src/providers/cursor-gateway-probe.ts -> container/agent-runner/src/providers/cursor-gateway-probe.ts
payload/container/agent-runner/src/providers/cursor-registration.test.ts -> container/agent-runner/src/providers/cursor-registration.test.ts
payload/container/agent-runner/src/providers/cursor.factory.test.ts -> container/agent-runner/src/providers/cursor.factory.test.ts
payload/container/agent-runner/src/providers/cursor-auth.test.ts -> container/agent-runner/src/providers/cursor-auth.test.ts
payload/container/agent-runner/src/providers/cursor-hook.test.ts -> container/agent-runner/src/providers/cursor-hook.test.ts
payload/container/agent-runner/src/providers/cursor.poll-loop.test.ts -> container/agent-runner/src/providers/cursor.poll-loop.test.ts
payload/container/agent-runner/src/providers/cursor.conformance.test.ts -> container/agent-runner/src/providers/cursor.conformance.test.ts
payload/container/agent-runner/src/providers/cursor.gateway-proxy.test.ts -> container/agent-runner/src/providers/cursor.gateway-proxy.test.ts
payload/container/agent-runner/src/provider-contracts/cursor.ts -> container/agent-runner/src/provider-contracts/cursor.ts
payload/setup/providers/cursor.ts -> setup/providers/cursor.ts
payload/setup/providers/cursor.test.ts -> setup/providers/cursor.test.ts
payload/setup/providers/cursor-registration.test.ts -> setup/providers/cursor-registration.test.ts
```

### 2. Wire the barrels

Append `import './cursor.js';` once to each of the five setup, provider, and contract barrels below. Keep all existing imports. Each barrel-registration test imports its real barrel and asserts `cursor` is registered.

```nc:append to:src/providers/index.ts when:cursor_core_ready=yes
import './cursor.js';
```

```nc:append to:src/provider-contracts/index.ts when:cursor_core_ready=yes
import './cursor.js';
```

```nc:append to:container/agent-runner/src/providers/index.ts when:cursor_core_ready=yes
import './cursor.js';
```

```nc:append to:container/agent-runner/src/provider-contracts/index.ts when:cursor_core_ready=yes
import './cursor.js';
```

```nc:append to:setup/providers/index.ts when:cursor_core_ready=yes
import './cursor.js';
```

### 3. Agent-runner dependency

The container talks to Cursor through `@cursor/sdk`, not a CLI binary. Pin the exact version in the agent-runner tree (Bun, not the host pnpm workspace — `@cursor/sdk` must not enter the host lockfile). Do not add a Cursor CLI to `container/cli-tools.json`.

```nc:dep manager:bun cwd:container/agent-runner when:cursor_core_ready=yes
@cursor/sdk@1.0.28
```

### 4. Build and test

```nc:run effect:build when:cursor_core_ready=yes
pnpm run build
```

```nc:run effect:build when:cursor_core_ready=yes
cd container/agent-runner && bun run typecheck
```

```nc:run effect:test when:cursor_core_ready=yes
pnpm exec vitest run src/providers/cursor-registration.test.ts src/providers/cursor-host-contribution.test.ts setup/providers
```

```nc:run effect:test when:cursor_core_ready=yes
cd container/agent-runner && bun test --isolate src/providers/cursor*.test.ts
```

```nc:run effect:test when:cursor_core_ready=yes
pnpm exec tsx scripts/provider-contract-verifier.ts --required-declared cursor
```

The verifier runs the host and runtime contract suites (registration, conformance, the gateway-proxy proof) and checks the host and runtime contract inventories agree. It goes red if a barrel line is missing, a barrel fails to evaluate, the payload is broken, or `@cursor/sdk` is not installed.

Build the local image. The SDK dependency requires a full local build.

```nc:run effect:build when:cursor_core_ready=yes
./container/build.sh build
```

## Authenticate

```nc:run effect:external when:cursor_core_ready=yes
pnpm exec tsx setup/index.ts --step provider-auth cursor
```

The same walk-through fresh installs get from the setup picker: sign in with a Cursor account (browser or URL), or enter a Cursor API key into the local masked prompt. Account sign-in runs the host-side helper (`bun container/agent-runner/src/providers/cursor-auth.ts`), which uses `Cursor.auth.login({ store: null })` to mint an expiring NanoClaw key into a mode-0600 handoff file; setup hands it to the credential gateway and deletes the file. The key is never printed, placed in process arguments, or sent through chat. The flow stores the key for those two routes, short-circuits only when the gateway already holds both, and finishes with the install check.

OAuth-minted keys default to 90 days; dashboard and service-account keys last until revoked. Prefer a dashboard or service-account key for unattended installs. To replace an expired or revoked key, remove both entries (`Cursor` for `api2.cursor.sh/auth/exchange_user_api_key`, `Cursor models` for `api.cursor.com/v1/models`) with your gateway's own tools, then re-run the provider-auth command.

## Use it

After installing on a running NanoClaw host, restart the host service first so it loads the Cursor registration (Linux: `systemctl --user restart nanoclaw-v2-<install-slug>.service`; macOS: its launchd restart). A host that still runs the old build spawns Cursor groups without the Cursor state volume, so continuations would not survive a container restart.

Then, per group:

```bash
ncl groups config update --id <group-id> --provider cursor
ncl groups restart --id <group-id>
```

Switching is an operator action — run it from the host. Every provider uses the
same `memory/` tree, so memory carries across automatically. Run
`/migrate-memory` only when upgrading a group that still has legacy `.seed.md`,
`CLAUDE.local.md`, or unindexed imported memory. See
[docs/provider-migration.md](../../docs/provider-migration.md).

`--model` selects the Cursor model (default `composer-2.5`). Cursor exposes no reasoning-effort or speed knob the container can map, so `--effort` is ignored and `--speed` is not accepted for cursor groups.

### Default new groups to cursor (optional)

New groups are created on the **instance default** (`DEFAULT_AGENT_PROVIDER` in `.env`, or `claude` when unset). Installing this skill wires cursor in but does NOT change that default — "installed" is not "authenticated", so the default stays claude until you opt in explicitly.

After install, ask the operator before flipping it:

> "Cursor is installed. Default new agent groups to cursor? Existing groups keep their current provider."

On yes — set it, then restart the host service as in **Use it** above so it takes effect:

```bash
pnpm exec tsx setup/index.ts --step set-env -- --key DEFAULT_AGENT_PROVIDER --value cursor
```

This affects only groups created afterward. Per-group `ncl groups config update --provider` still overrides the default in either direction.

## Troubleshooting

- **Container dies at boot, channel silent:** `grep 'Container exited non-zero' logs/nanoclaw.error.log` — the `stderrTail` carries the reason (e.g. `Unknown provider: cursor. Registered: claude` means the barrels aren't wired in the running build).
- **401 after months of working:** an OAuth-minted user key expired (default 90 days). Remove both Cursor entries from the gateway and re-run `pnpm exec tsx setup/index.ts --step provider-auth cursor`. Prefer a dashboard or service-account key for unattended installs.
- **Auth errors mid-conversation:** the gateway entry is missing or stale — same rotation as above.
- **`@cursor/sdk` missing inside the container:** the image predates the pin — re-run `./container/build.sh build`.
- **Traffic and the gateway:** under Bun the SDK's key exchange, model discovery, and Connect RPCs (HTTP/1.1) all honor `HTTPS_PROXY` and the gateway CA, and the provider pins HTTP/1.1. The one path that cannot be proxied is an HTTP/2 Connect transport (`node:http2` ignores `HTTPS_PROXY`), which the SDK selects only when Cursor's server-side `http2Config` forces HTTP/2 over the client pin. While a proxy is configured the provider refuses that path client-side: the run fails with `Cursor SDK attempted an HTTP/2 connection to <authority> that would bypass the configured proxy; refusing` instead of the agent's runtime token (never the stored key) leaving the container directly. Seeing that error means Cursor is forcing HTTP/2 — check Cursor's status and retry later; do not remove the proxy. The operator-side layer is core's `NANOCLAW_EGRESS_LOCKDOWN=true`: the container runs on an internal Docker network whose only hop is the gateway, so any bypass attempt fails at the network as well.

To remove the provider, follow [REMOVE.md](REMOVE.md).
