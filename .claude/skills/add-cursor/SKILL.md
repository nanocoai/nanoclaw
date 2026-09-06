---
name: add-cursor
description: Use Cursor (local Agent SDK) as a full agent provider — planning, tool orchestration, MCP tools, session resume — alongside or instead of Claude. Cursor-account sign-in or API key, vault-only via OneCLI. Per-group via `ncl groups config update --provider cursor`. Distinct from using Cursor as a cloud agent (those run on Cursor VMs and are not this provider).
metadata:
  nanoclaw-provider: cursor
  nanoclaw-provider-label: Cursor
  nanoclaw-provider-hint: Cursor — account sign-in or API key
  nanoclaw-provider-offered: 'true'
  nanoclaw-provider-image: local-required
---

# Cursor agent provider

> Shortcut: `pnpm exec tsx setup/index.ts --step provider-auth cursor` performs this whole install (payload from the providers branch: files, barrels, SDK pin, image rebuild) plus auth in one command. The steps below are the same operations, for agent-driven or manual application.

NanoClaw selects each group's agent backend from `container_configs.provider` (default `claude`). This skill installs the Cursor provider: copy the payload from the `providers` branch, append one import to each of the five provider and contract barrels, pin `@cursor/sdk` in the agent-runner tree, rebuild, then run the vault auth walk-through.

The provider runs `@cursor/sdk` in-process inside the container (`Agent.create` / `resume` / `send`): native streaming, MCP tools, a local agent store (the continuation is a Cursor `agentId`). It integrates through the provider contracts only — a data-only host contract declares the composed `AGENTS.md`, the per-group `.cursor-shared` state volume at `~/.cursor`, and the two Cursor-native skill directories; the runtime contract declares the execution stance, model mapping, memory hooks, and MCP mapping. Core composes the project document from those facts; no provider prose or provider-written files on the host.

Credentials are **vault-only**: the container only ever sees the placeholder `CURSOR_API_KEY=cursor_placeholder_nanoclaw`, which the SDK sends as a bearer header, and the credential gateway rewrites it in flight on two narrowly scoped routes — `api2.cursor.sh/auth/exchange_user_api_key` (the SDK swaps the user key for a short-lived runtime token) and `api.cursor.com/v1/models` (model discovery). The runtime token stays in the SDK's memory and rides the same gateway proxy on the agent's Connect RPCs. The payload ships `cursor.gateway-proxy.test.ts`, which proves every request of a real SDK run transits the proxy carrying nothing but the placeholder. Never put a key in chat.

The mechanical steps under **Install** carry `nc:` directive fences: an agent reads the prose and applies them, and a parser can apply them deterministically from the same document. Every directive is idempotent, so the whole skill is safe to re-run; anything a parser can't apply falls back to the prose beside it.

## Install

### Pre-flight

Requires the provider-contract core: `src/provider-contracts/index.ts` and `container/agent-runner/src/provider-contracts/index.ts` on trunk. If either is missing, stop and tell the operator to run `/update-nanoclaw` first.

Check whether the payload is already wired (a prior apply). All of these present means installed — skip to **Authenticate**:

- `src/providers/cursor.ts` and `src/provider-contracts/cursor.ts`
- `container/agent-runner/src/providers/cursor.ts`, `cursor-auth.ts`, `cursor-hook.ts`, and `container/agent-runner/src/provider-contracts/cursor.ts`
- `setup/providers/cursor.ts`
- `import './cursor.js';` in the three provider barrels and both contract barrels
- `@cursor/sdk` pinned to `1.0.28` in `container/agent-runner/package.json`

### 1. Fetch and copy the payload

Fetch the `providers` branch and copy the Cursor payload into all three trees (additive — overwrite each file, never merge the branch). The canonical remote is `nanocoai/nanoclaw` (`origin` on a normal clone; a fork should fetch from that upstream, not from itself). The host files are the data-only host contract + the legacy env adapter + their guards; the container files are the provider runtime (turn loop, event mapping, hooks.json writer, shared exchange archiver), the runtime contract, the memory hook adapter, the host-side login helper, and their guards — including the conformance test the verifier requires and the gateway-proxy proof; the setup file is the picker entry + vault auth walk-through.

```nc:copy from-branch:providers
src/providers/cursor.ts
src/providers/cursor-registration.test.ts
src/providers/cursor-host-contribution.test.ts
src/provider-contracts/cursor.ts
container/agent-runner/src/providers/cursor.ts
container/agent-runner/src/providers/cursor-auth.ts
container/agent-runner/src/providers/cursor-hook.ts
container/agent-runner/src/providers/cursor-gateway-probe.ts
container/agent-runner/src/providers/exchange-archive.ts
container/agent-runner/src/providers/exchange-archive.test.ts
container/agent-runner/src/providers/cursor-registration.test.ts
container/agent-runner/src/providers/cursor.factory.test.ts
container/agent-runner/src/providers/cursor-auth.test.ts
container/agent-runner/src/providers/cursor-hook.test.ts
container/agent-runner/src/providers/cursor.poll-loop.test.ts
container/agent-runner/src/providers/cursor.conformance.test.ts
container/agent-runner/src/providers/cursor.gateway-proxy.test.ts
container/agent-runner/src/provider-contracts/cursor.ts
setup/providers/cursor.ts
setup/providers/cursor.test.ts
setup/providers/cursor-registration.test.ts
```

### 2. Wire the barrels

Append the self-registration import to each provider and contract barrel (skipped if already present). Each barrel-registration test imports its real barrel and asserts `cursor` is registered — they go red the moment a barrel line is missing or drifts.

```nc:append to:src/providers/index.ts
import './cursor.js';
```

```nc:append to:src/provider-contracts/index.ts
import './cursor.js';
```

```nc:append to:container/agent-runner/src/providers/index.ts
import './cursor.js';
```

```nc:append to:container/agent-runner/src/provider-contracts/index.ts
import './cursor.js';
```

```nc:append to:setup/providers/index.ts
import './cursor.js';
```

### 3. Agent-runner dependency

The container talks to Cursor through `@cursor/sdk`, not a CLI binary. Pin the exact version in the agent-runner tree (Bun, not the host pnpm workspace — `@cursor/sdk` must not enter the host lockfile). Re-running `bun add` of the same pin is a no-op. Do not run `bun update`.

```nc:dep manager:bun cwd:container/agent-runner
@cursor/sdk@1.0.28
```

The version (`1.0.28`) is the canonical pin — this SKILL.md is the source of truth. Do not add a Cursor CLI to `container/cli-tools.json`; the container uses the library.

### 4. Build

```nc:run effect:build
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh
```

### 5. Validate

```nc:run effect:test
pnpm exec tsx scripts/provider-contract-verifier.ts --required-declared cursor
```

The verifier runs the host and runtime contract suites (registration, conformance, the gateway-proxy proof) and checks the host and runtime contract inventories agree. It goes red if a barrel line is missing, a barrel fails to evaluate, the payload is broken, or `@cursor/sdk` is not installed.

## Authenticate

```nc:run effect:external
pnpm exec tsx setup/index.ts --step provider-auth cursor
```

The same walk-through fresh installs get from the setup picker: sign in with a Cursor account (browser or URL), or enter a Cursor API key into the local masked prompt. Account sign-in runs the host-side helper (`bun container/agent-runner/src/providers/cursor-auth.ts`), which uses `Cursor.auth.login({ store: null })` to mint an expiring NanoClaw key, writes it straight to a mode-0600 handoff file, and asks OneCLI to consume that file; manual keys use the same handoff. The key is never printed, placed in process arguments, or sent through chat. The flow creates one generic OneCLI entry per exact SDK route (`api2.cursor.sh/auth/exchange_user_api_key` and `api.cursor.com/v1/models`), short-circuits only when both exist, and finishes with the install check.

OAuth-minted keys default to 90 days; dashboard and service-account keys last until revoked. Prefer a dashboard or service-account key for unattended installs. To replace an expired or revoked key: `onecli secrets list`, `onecli secrets delete --id <id>` for both Cursor entries, then re-run the provider-auth command.

## Use it

Per group:

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

On yes — set it, then restart the host so it takes effect:

```bash
pnpm exec tsx setup/index.ts --step set-env -- --key DEFAULT_AGENT_PROVIDER --value cursor
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS; Linux: systemctl --user restart nanoclaw
```

This affects only groups created afterward. Per-group `ncl groups config update --provider` still overrides the default in either direction.

## Troubleshooting

- **Container dies at boot, channel silent:** `grep 'Container exited non-zero' logs/nanoclaw.error.log` — the `stderrTail` carries the reason (e.g. `Unknown provider: cursor. Registered: claude` means the barrels aren't wired in the running build).
- **401 after months of working:** an OAuth-minted user key expired (default 90 days). Delete both Cursor vault entries and re-run `pnpm exec tsx setup/index.ts --step provider-auth cursor`. Prefer a dashboard or service-account key for unattended installs.
- **Auth errors mid-conversation:** the vault secret is missing or stale — same rotation as above.
- **`@cursor/sdk` missing inside the container:** the image predates the pin — re-run `./container/build.sh`.
- **Traffic and the gateway:** under Bun the SDK's key exchange, model discovery, and Connect RPCs (HTTP/1.1) all honor `HTTPS_PROXY` and the gateway CA, and the provider pins HTTP/1.1. The one path that cannot be proxied is an HTTP/2 Connect transport (`node:http2` ignores `HTTPS_PROXY`), which the SDK selects only when Cursor's server-side `http2Config` forces HTTP/2 over the client pin. While a proxy is configured the provider refuses that path client-side: the run fails with `Cursor SDK attempted an HTTP/2 connection to <authority> that would bypass the configured proxy; refusing` instead of the agent's runtime token (never the vaulted key) leaving the container directly. Seeing that error means Cursor is forcing HTTP/2 — check Cursor's status and retry later; do not remove the proxy. The operator-side layer is core's `NANOCLAW_EGRESS_LOCKDOWN=true`: the container runs on an internal Docker network whose only hop is the gateway, so any bypass attempt fails at the network as well.
