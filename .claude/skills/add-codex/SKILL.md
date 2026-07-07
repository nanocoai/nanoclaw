---
name: add-codex
description: Use Codex (OpenAI's codex app-server) as a full agent provider — planning, tool orchestration, MCP tools, server-side history, session resume — alongside or instead of Claude. ChatGPT subscription or OpenAI API key, vault-only via OneCLI. Per-group via `ncl groups config update --provider codex`. Distinct from using OpenAI as an MCP tool (where Claude remains the planner).
---

# Codex agent provider

> Shortcut: `pnpm exec tsx setup/index.ts --step provider-auth codex` performs this whole install (manifest-driven from the providers branch: files, barrels, CLI manifest entry, image rebuild) plus auth in one command. The steps below are the same operations, for agent-driven or manual application.

NanoClaw selects each group's agent backend from `container_configs.provider` (default `claude`). This skill installs the Codex provider: copy the payload from the `providers` branch, append one import to each of the three provider barrels, add the pinned Codex CLI to the container manifest (`container/cli-tools.json`), rebuild, then run the vault auth walk-through.

The provider runs `codex app-server` as a child process speaking JSON-RPC over stdio: native streaming, MCP tools, server-side conversation history (the continuation is a thread id, no on-disk transcript). Credentials are **vault-only**: OneCLI serves a sentinel `auth.json` stub into the container and swaps the real ChatGPT token or API key on the wire — no key in `.env`, nothing readable in the container.

## Install

### Pre-flight

Check whether the payload is already wired (a prior apply, or a trunk that still carries it). All of these present means installed — skip to **Authenticate**:

- `src/providers/codex.ts` and `src/providers/codex-agents-md.ts`
- `container/agent-runner/src/providers/codex.ts` and `codex-app-server.ts`
- `setup/providers/codex.ts`
- `import './codex.js';` in `src/providers/index.ts`, `container/agent-runner/src/providers/index.ts`, and `setup/providers/index.ts`
- an `@openai/codex` entry in `container/cli-tools.json`

### Fetch and copy

```bash
git fetch origin providers
```

Copy each file with `git show origin/providers:<path> > <path>` (additive — never merge the branch):

Host (`src/providers/`):
- `codex.ts` — provider contribution: per-group `.codex-shared` state dir, AGENTS.md compose, skill links
- `codex-agents-md.ts` — AGENTS.md composition (32KB Codex cap: degrades by dropping the largest instruction sections, never blocks a spawn)
- `codex-registration.test.ts` — barrel-driven host registration guard
- `codex-host-contribution.test.ts` — drives the real contribution against a real test DB (the "consumes core" leg)
- `codex-agents-md.test.ts` — cap-degradation behavior

Container (`container/agent-runner/src/providers/`):
- `codex.ts` — the provider (turn loop, steering, memory scaffold + `onExchangeComplete` archiving)
- `codex-app-server.ts` — JSON-RPC child-process wrapper
- `exchange-archive.ts` — per-exchange markdown writer the `onExchangeComplete` hook uses (provider-owned, not runner code)
- `exchange-archive.test.ts` — writer behavior
- `codex-registration.test.ts` — barrel-driven container registration guard
- `codex.factory.test.ts`, `codex.turns.test.ts`, `codex-app-server.test.ts` — provider behavior
- `codex-cli-tools.test.ts` — structural guard for the Codex entry in `container/cli-tools.json`

Setup (`setup/providers/`):
- `codex.ts` — picker entry self-registration + the vault auth walk-through + install check
- `codex.test.ts` — install-check coverage
- `codex-registration.test.ts` — barrel-driven setup registration guard

Shared base (skip if present):
- `container/AGENTS.md` — the runtime-contract base the composed AGENTS.md embeds

### Wire the barrels

Append `import './codex.js';` to each of:
- `src/providers/index.ts`
- `container/agent-runner/src/providers/index.ts`
- `setup/providers/index.ts`

### CLI manifest

The agent's global Node CLIs install from `container/cli-tools.json` (a json-merge seam), not hand-edited Dockerfile layers. Add Codex by appending one entry — `@openai/codex` has no native postinstall, so no `onlyBuilt`:

```bash
node -e '
  const fs = require("fs");
  const file = "container/cli-tools.json";
  const tools = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!tools.some((t) => t.name === "@openai/codex")) {
    tools.push({ name: "@openai/codex", version: "0.138.0" });
    const fmt = (t) => "  { " + Object.entries(t).map(([k, v]) => JSON.stringify(k) + ": " + JSON.stringify(v)).join(", ") + " }";
    fs.writeFileSync(file, "[\n" + tools.map(fmt).join(",\n") + "\n]\n");
  }
'
```

The version (`0.138.0`) is the canonical pin — keep it in sync with `setup/add-codex.sh`. The Dockerfile already installs every manifest entry via pinned `pnpm install -g`; no Dockerfile edit is needed.

### Build

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh
```

### Restart the host

The image rebuild does not reload the **host**. Codex's host contribution
(`src/providers/codex.ts`) registers the `/home/node/.codex` bind mount + env
passthrough, and the running host only picks it up on restart. Skip this and the
first Codex turn fails with `EACCES` writing `/home/node/.codex/config.toml` —
with no mount, Docker auto-creates the dir root-owned and the non-root container
user can't write to it.

```bash
# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux (systemd)
systemctl --user restart nanoclaw
```

### Validate

```bash
pnpm vitest run src/providers/codex-registration.test.ts src/providers/codex-host-contribution.test.ts src/providers/codex-agents-md.test.ts setup/providers/
cd container/agent-runner && bun test src/providers/
```

The registration tests import only the real barrels — they go red if a barrel line is missing, a barrel fails to evaluate, or the payload is broken.

## Authenticate

> **Run this in a separate, real terminal — it is interactive.** It prompts for ChatGPT-subscription vs OpenAI-API-key and then drives a browser/device login, so it needs a TTY to answer prompts.

```bash
pnpm exec tsx setup/index.ts --step provider-auth codex
```

The same walk-through fresh installs get from the setup picker: ChatGPT subscription (browser login or device pairing) or an OpenAI API key, landed in the OneCLI vault. Idempotent — it short-circuits when a matching secret already exists. It finishes with the install check.

## Use it

Per group:

```bash
ncl groups config update --id <group-id> --provider codex
ncl groups restart --id <group-id>
```

Switching is an operator action — run it from the host. Memory does NOT carry over automatically — each provider keeps its own store; run `/migrate-memory` to carry it across. See [docs/provider-migration.md](../../docs/provider-migration.md) for the carry-over table and rollback.

There is no install-wide default provider. Setup's provider picker sets codex on the first agent it creates; creation itself is provider-agnostic (no `--provider` flag — provider is a DB property). Any group switches afterward via `ncl groups config update --provider` as above.

## Troubleshooting

- **Container dies at boot, channel silent:** `grep 'Container exited non-zero' logs/nanoclaw.error.log` — the `stderrTail` carries the reason (e.g. `Unknown provider: codex. Registered: claude` means the barrels aren't wired in the running build).
- **In-channel `Error: spawn codex ENOENT` on every message:** the image predates the manifest entry — re-run `./container/build.sh`.
- **Auth errors mid-conversation:** the vault secret is missing or stale — re-run `pnpm exec tsx setup/index.ts --step provider-auth codex` (subscription re-login updates the vault copy).
