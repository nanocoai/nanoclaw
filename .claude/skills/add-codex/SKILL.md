---
name: add-codex
description: Use Codex (OpenAI's codex app-server) as a full agent provider — planning, tool orchestration, MCP tools, server-side history, session resume — alongside or instead of Claude. ChatGPT subscription or OpenAI API key, vault-only via the selected gateway. Per-group via `ncl groups config update --provider codex`. Distinct from using OpenAI as an MCP tool (where Claude remains the planner).
metadata:
  nanoclaw-provider: codex
  nanoclaw-provider-label: Codex
  nanoclaw-provider-hint: OpenAI — ChatGPT subscription or API key
  nanoclaw-provider-offered: 'true'
  nanoclaw-provider-image: local-required
---

# Codex agent provider

> Shortcut: `pnpm exec tsx setup/index.ts --step provider-auth codex` performs this whole install (manifest-driven from this skill's payload: files, barrels, CLI manifest entry, image rebuild, host rebuild and restart) plus auth in one command. The steps below are the same operations, for agent-driven or manual application.

NanoClaw selects each group's agent backend from `container_configs.provider` (default `claude`). This skill installs the Codex provider: copy this skill's payload, append one import to each of the three provider barrels, add the pinned Codex CLI to the container manifest (`container/cli-tools.json`), rebuild, then run the vault auth walk-through.

The provider runs `codex app-server` as a child process speaking JSON-RPC over stdio: native streaming, MCP tools, server-side conversation history (the continuation is a thread id, no on-disk transcript). Credentials are **vault-only**: The selected gateway serves a sentinel `auth.json` stub into the container and swaps the real ChatGPT token or API key on the wire — no key in `.env`, nothing readable in the container.

The mechanical steps under **Install** carry `nc:` directive fences: an agent reads the prose and applies them, and a parser can apply them deterministically from the same document. Every directive is idempotent, so the whole skill is safe to re-run; anything a parser can't apply falls back to the prose beside it.

## Install

### Pre-flight

Requires `src/project-doc-compose.ts` and core's shared exchange archive
(`container/agent-runner/src/provider-contracts/exchange-archive.ts`) on trunk.
If either is missing, stop and tell the operator to run `/update-nanoclaw` first.

Check whether the payload is already wired (a prior apply, or a trunk that still carries it). All of these present means installed — skip to **Authenticate**:

- `src/providers/codex.ts` and `src/providers/codex-agents-md.ts`
- `container/agent-runner/src/providers/codex.ts` and `codex-app-server.ts`
- `setup/providers/codex.ts` and both `provider-contracts/codex.ts` declarations (host and container)
- `import './codex.js';` in the three provider barrels and both contract barrels
- an `@openai/codex` entry in `container/cli-tools.json`

### 1. Copy the payload

Copy the Codex payload from this skill's `payload/` into all three trees (additive — overwrite each file). The host files are the provider contribution + the AGENTS.md spec (composition itself lives in trunk's `src/project-doc-compose.ts`) + their guards; the container files are the provider runtime (turn loop, JSON-RPC wrapper, native memory SessionStart hook) + their guards, and the runtime contract archives each exchange through core's shared archive; the setup files are the picker entry + vault auth walk-through + their guards; `container/AGENTS.md` is the runtime-contract base the composed AGENTS.md embeds.

The host contract (`src/provider-contracts/codex.ts`) and the setup entry carry the authentication hook for the selected gateway: the same login choices, with custody delegated to the gateway. The setup screens and step sequence do not change.

```nc:copy
payload/src/providers/codex.ts -> src/providers/codex.ts
payload/src/providers/codex-agents-md.ts -> src/providers/codex-agents-md.ts
payload/src/providers/codex-registration.test.ts -> src/providers/codex-registration.test.ts
payload/src/providers/codex-host-contribution.test.ts -> src/providers/codex-host-contribution.test.ts
payload/src/providers/codex-agents-md.test.ts -> src/providers/codex-agents-md.test.ts
payload/container/agent-runner/src/providers/codex.ts -> container/agent-runner/src/providers/codex.ts
payload/container/agent-runner/src/providers/codex-app-server.ts -> container/agent-runner/src/providers/codex-app-server.ts
payload/container/agent-runner/src/providers/codex-registration.test.ts -> container/agent-runner/src/providers/codex-registration.test.ts
payload/container/agent-runner/src/providers/codex.factory.test.ts -> container/agent-runner/src/providers/codex.factory.test.ts
payload/container/agent-runner/src/providers/codex.turns.test.ts -> container/agent-runner/src/providers/codex.turns.test.ts
payload/container/agent-runner/src/providers/codex-app-server.test.ts -> container/agent-runner/src/providers/codex-app-server.test.ts
payload/container/agent-runner/src/providers/codex-contract-parity.test.ts -> container/agent-runner/src/providers/codex-contract-parity.test.ts
payload/container/agent-runner/src/providers/codex.conformance.test.ts -> container/agent-runner/src/providers/codex.conformance.test.ts
payload/container/agent-runner/src/providers/codex-cli-tools.test.ts -> container/agent-runner/src/providers/codex-cli-tools.test.ts
payload/container/agent-runner/src/provider-contracts/codex.ts -> container/agent-runner/src/provider-contracts/codex.ts
payload/setup/providers/codex-registration.test.ts -> setup/providers/codex-registration.test.ts
payload/container/AGENTS.md -> container/AGENTS.md
payload/src/provider-contracts/codex.ts -> src/provider-contracts/codex.ts
payload/setup/providers/codex.ts -> setup/providers/codex.ts
payload/setup/providers/codex.test.ts -> setup/providers/codex.test.ts
```

The payload used to ship its own copy of the exchange archive. Once neither Codex
file imports it, this step removes it, so a refreshed install ends up with the same
files as a fresh one. An install that kept older Codex files keeps the copy they need.

```nc:run effect:refresh
grep -qsF ./exchange-archive.js container/agent-runner/src/providers/codex.ts || grep -qsF providers/exchange-archive.js container/agent-runner/src/provider-contracts/codex.ts || rm -f container/agent-runner/src/providers/exchange-archive.ts container/agent-runner/src/providers/exchange-archive.test.ts
```

### 2. Wire the barrels

Append the self-registration import to each provider and contract barrel (skipped if already present).

```nc:append to:src/providers/index.ts
import './codex.js';
```

```nc:append to:src/provider-contracts/index.ts
import './codex.js';
```

```nc:append to:container/agent-runner/src/provider-contracts/index.ts
import './codex.js';
```

```nc:append to:container/agent-runner/src/providers/index.ts
import './codex.js';
```

```nc:append to:setup/providers/index.ts
import './codex.js';
```

### 3. CLI manifest

The agent's global Node CLIs install from `container/cli-tools.json` (a json-merge seam), not hand-edited Dockerfile layers. Add Codex by appending one entry — idempotent on `name`, so a re-run is a no-op. `@openai/codex` has no native postinstall, so no `onlyBuilt`. The Dockerfile already installs every manifest entry via pinned `pnpm install -g`; no Dockerfile edit is needed.

```nc:json-merge into:container/cli-tools.json key:name
{ "name": "@openai/codex", "version": "0.162.1" }
```

The version (`0.162.1`) is the canonical pin — this SKILL.md is the source of truth.
Codex 0.156.0 and later look up the login's workspace id before any model request, so a ChatGPT login needs the credential gateway skill from the same NanoClaw release, which puts that id in the agent's stand-in login. `/update-nanoclaw` refreshes both together; do not refresh this skill alone on an older gateway.

### 4. Build

```nc:run effect:build
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh
```

### 5. Validate

```nc:run effect:test
pnpm exec tsx scripts/provider-contract-verifier.ts --required-declared codex
```

The registration tests import only the real barrels — they go red if a barrel line is missing, a barrel fails to evaluate, or the payload is broken.

## Authenticate

```nc:run effect:external
pnpm exec tsx setup/index.ts --step provider-auth codex
```

The same walk-through fresh installs get from the setup picker: ChatGPT subscription (browser login or device pairing) or an OpenAI API key, landed in the selected gateway’s vault. Idempotent — it short-circuits when a matching secret already exists. It finishes with the install check.

## Use it

After applying the steps above by hand on a running NanoClaw host, restart it first so it loads the Codex registration: `bash setup/lib/restart.sh`. The provider-auth shortcut already did this. A host still on the old build doesn't know Codex, and Codex groups fail on their first message.

Then, per group:

```bash
ncl groups config update --id <group-id> --provider codex
ncl groups restart --id <group-id>
```

Switching is an operator action — run it from the host. Every provider uses the
same `memory/` tree, so memory carries across automatically. Run
`/migrate-memory` only when upgrading a group that still has legacy `.seed.md`,
`CLAUDE.local.md`, or unindexed imported memory. See
[docs/provider-migration.md](../../docs/provider-migration.md).

### Default new groups to codex (optional)

New groups are created on the **instance default** (`DEFAULT_AGENT_PROVIDER` in `.env`, or `claude` when unset). Installing this skill wires codex in but does NOT change that default — "installed" is not "authenticated", so the default stays claude until you opt in explicitly.

After install, ask the operator before flipping it:

> "Codex is installed. Default new agent groups to codex? Existing groups keep their current provider."

On yes — set it, then restart the host so it takes effect:

```bash
pnpm exec tsx setup/index.ts --step set-env -- --key DEFAULT_AGENT_PROVIDER --value codex
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS; Linux: systemctl --user restart nanoclaw
```

This affects only groups created afterward. Per-group `ncl groups config update --provider` still overrides the default in either direction. Creation itself stays provider-agnostic (no `--provider` flag — provider is a DB property stamped from the instance default at creation).

## Troubleshooting

- **Container dies at boot, channel silent:** `grep 'Container exited non-zero' logs/nanoclaw.error.log` — the `stderrTail` carries the reason (e.g. `Unknown provider: codex. Registered: claude` means the barrels aren't wired in the running build).
- **In-channel `Error: spawn codex ENOENT` on every message:** the image predates the manifest entry — re-run `./container/build.sh`.
- **Auth errors mid-conversation:** the vault secret is missing or stale — re-run `pnpm exec tsx setup/index.ts --step provider-auth codex` (subscription re-login updates the vault copy).
