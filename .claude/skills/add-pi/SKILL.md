---
name: add-pi
description: Use pi (pi Coding Agent) as an agent provider. In-process pi SDK inside the container — no serve process, no global CLI. Models and credentials come from the selected gateway; the host mounts a per-group pi agentDir and passes PI_AGENT_DIR. Per group via `ncl groups config update --provider pi`.
metadata:
  nanoclaw-provider: pi
  nanoclaw-provider-label: pi
  nanoclaw-provider-hint: In-process pi SDK — models via the gateway
  nanoclaw-provider-offered: 'true'
  nanoclaw-provider-image: local-required
---

# pi agent provider

Install [pi](https://github.com/earendil-works/pi) as an optional NanoClaw
runtime. The payload is included in this skill; it needs no separate provider
branch. It uses the upstream runtime, instructions, host, and setup metadata
contracts at seam version 1.

pi is an **in-process SDK** provider: the container runner embeds
`@earendil-works/pi-coding-agent` directly. There is no `pi serve` process, no
SSE subscription, and no global CLI — the whole server-lifecycle complexity
class of the OpenCode provider does not exist here. MCP servers are bridged to
pi `customTools` in process by `mcp-to-pi.ts`.

pi resolves models and credentials **exclusively from its agentDir files**; the
SDK reads no auth from environment variables. The host therefore declares the
group's pi state directory as a state volume
(`/home/node/.pi/agent`, from `data/v2-sessions/<group>/.pi-shared`) and passes
`PI_AGENT_DIR`. Credentials are **gateway-owned**: the container writes fixed
`gateway-managed` placeholders into the agentDir before every session open, and
the selected gateway replaces them on the wire. No personal `auth.json` is
copied into the container.

pi is offered by the standard setup provider picker. Existing installs can add
or authenticate it with `pnpm exec tsx setup/index.ts --step provider-auth pi`.
Append `--refresh` only to replace an installed payload and update its pins;
back up local payload edits first. Ordinary re-authentication leaves installed
files and the container image alone.

## Install

Install and refresh require host contract version 1 and credential-connection
seam version 1. The compatibility predicate below guards every subsequent step,
so an unsupported core receives no partial payload or dependency changes.

```nc:run effect:refresh capture:pi_core_ready validate:^yes$
node -e "const fs=require('fs'); const p='src/provider-contracts/registry.ts', g='setup/gateways/credential-store.ts'; if(fs.existsSync(p) && /PROVIDER_HOST_CONTRACT_SEAM_VERSION = 1/.test(fs.readFileSync(p,'utf8')) && fs.existsSync(g) && /PROVIDER_CREDENTIAL_CONNECTION_SEAM_VERSION = 1/.test(fs.readFileSync(g,'utf8'))) console.log('yes'); else console.log('no')"
```

Copy only the files listed below from this skill's `payload/` to the matching
paths at the project root. These are skill-owned files; overwrite them together
when refreshing the skill. Keep the core-owned registries and contract
realization files in place. pi needs no `cwd-shim`: the MCP SDK's stdio
transport has a native spawn-directory field, so the bridge passes `cwd`
through directly.

```nc:copy when:pi_core_ready=yes
payload/container/agent-runner/src/provider-contracts/pi.ts -> container/agent-runner/src/provider-contracts/pi.ts
payload/container/agent-runner/src/providers/mcp-to-pi.ts -> container/agent-runner/src/providers/mcp-to-pi.ts
payload/container/agent-runner/src/providers/mcp-to-pi.test.ts -> container/agent-runner/src/providers/mcp-to-pi.test.ts
payload/container/agent-runner/src/providers/pi-auth.ts -> container/agent-runner/src/providers/pi-auth.ts
payload/container/agent-runner/src/providers/pi-auth.test.ts -> container/agent-runner/src/providers/pi-auth.test.ts
payload/container/agent-runner/src/providers/pi-registration.test.ts -> container/agent-runner/src/providers/pi-registration.test.ts
payload/container/agent-runner/src/providers/pi.conformance.test.ts -> container/agent-runner/src/providers/pi.conformance.test.ts
payload/container/agent-runner/src/providers/pi.empty-resume.test.ts -> container/agent-runner/src/providers/pi.empty-resume.test.ts
payload/container/agent-runner/src/providers/pi.factory.test.ts -> container/agent-runner/src/providers/pi.factory.test.ts
payload/container/agent-runner/src/providers/pi.turns.test.ts -> container/agent-runner/src/providers/pi.turns.test.ts
payload/container/agent-runner/src/providers/pi.ts -> container/agent-runner/src/providers/pi.ts
payload/src/provider-contracts/pi.ts -> src/provider-contracts/pi.ts
payload/src/providers/pi.ts -> src/providers/pi.ts
payload/setup/providers/pi.ts -> setup/providers/pi.ts
```

Append `import './pi.js';` once to each of the five setup, provider, contract,
and host barrels below. Keep all existing imports.

```nc:append to:src/providers/index.ts when:pi_core_ready=yes
import './pi.js';
```

```nc:append to:src/provider-contracts/index.ts when:pi_core_ready=yes
import './pi.js';
```

```nc:append to:container/agent-runner/src/providers/index.ts when:pi_core_ready=yes
import './pi.js';
```

```nc:append to:container/agent-runner/src/provider-contracts/index.ts when:pi_core_ready=yes
import './pi.js';
```

```nc:append to:setup/providers/index.ts when:pi_core_ready=yes
import './pi.js';
```

Install the pinned SDK in the runner's Bun package. Do not use `latest`: the
provider code is written and tested against the 1.3.x SDK surface. The MCP
bridge uses `@modelcontextprotocol/sdk`, which is already an agent-runner
dependency. There is no host SDK dependency and no CLI manifest entry — pi is a
pure in-process dependency of the agent-runner.

```nc:dep manager:bun cwd:container/agent-runner when:pi_core_ready=yes
@earendil-works/pi-coding-agent@1.3.0
```

Build the host, typecheck the runner, and run the pi tests. The tests exercise
real barrel registration, the provider-owned contract conformance suite, the
MCP bridge (including an in-memory end-to-end transport), turn/push behavior,
empty-resume rotation, and the gateway-auth placeholder writer.

```nc:run effect:build when:pi_core_ready=yes
pnpm run build
```

```nc:run effect:build when:pi_core_ready=yes
cd container/agent-runner && bun run typecheck
```

```nc:run effect:test when:pi_core_ready=yes
pnpm exec vitest run src/providers src/provider-contracts setup/providers
```

```nc:run effect:test when:pi_core_ready=yes
cd container/agent-runner && bun test --isolate src/providers/pi*.test.ts src/providers/mcp-to-pi.test.ts
```

Build the local image with `./container/build.sh build`: the new SDK dependency
requires a full local build, and a CLI-only overlay cannot supply it. This
switches a published-image installation to locally built images.

```nc:run effect:build when:pi_core_ready=yes
./container/build.sh build
```

## Configure models and credentials

pi reads everything from its agentDir. The host mounts the group's shared
directory at pi's agentDir, `/home/node/.pi/agent` (the group's `.pi-shared`).
Files there are operator-owned and survive container restarts.

### ChatGPT subscription (pi's `openai-codex` provider)

1. Store the ChatGPT login in the gateway once:
   `pnpm exec tsx setup/index.ts --step provider-auth codex`.
2. `provider-auth pi` → **ChatGPT subscription (Codex)** verifies it and records
   `openai-codex` in `PI_GATEWAY_PROVIDERS`. There is nothing else to do: the
   container writes the `openai-codex` placeholder and the gateway injects the
   real token and account header by host.

### API-key providers

Run `pnpm exec tsx setup/index.ts --step provider-auth pi` → **Save a provider
API key** and pick Anthropic, OpenAI, Google, OpenRouter, or DeepSeek. The key
is stored in the selected gateway, and the provider id is recorded in
`PI_GATEWAY_PROVIDERS` so the container writes a matching
`gateway-managed` placeholder entry. The gateway injects the real key by host.

For any provider pi supports but this hook does not cover, store the key with
the gateway's own flow and add the placeholder yourself:

```json
{ "anthropic": { "type": "api_key", "key": "gateway-managed" } }
```

in the group's `auth.json`, or the equivalent `apiKey` field in a `models.json`
entry. Never put a real key in either file, in `.env`, or in the container
environment.

**Grant the secret to the agent group.** OneCLI only injects secrets assigned to
an agent (`secretMode: selective`), so a saved-but-ungranted key reaches the
provider as `401 access restricted` even though the request is routed. Grant it
with the selected gateway's own flow — for OneCLI,
`PUT /v1/agents/<agentId>/grants/secrets/<secretId>` (its CLI's
`agents set-secrets` endpoint is retired). New groups get a new agent, so grant
after each group is created, or the group's first turns fail until you do.

### Model selection

pi would otherwise start on its built-in default provider (Anthropic), which
the gateway usually holds no key for, so the container writes `settings.json`
with `defaultProvider` and `defaultModel` for the single provider recorded in
`PI_GATEWAY_PROVIDERS`; the model is pi's own default for that provider.

Override it without touching the container by editing
`data/v2-sessions/<group-id>/.pi-shared/settings.json` (`defaultProvider` /
`defaultModel` / `models.json` custom providers), or set `PI_DEFAULT_PROVIDER`
and optional `PI_DEFAULT_MODEL` in `.env`. Operator-authored settings are never
overwritten. `ANTHROPIC_BASE_URL` and friends are not read by the pi provider.

## Select a group

```bash
ncl groups config update --id <group-id> --provider pi
ncl groups restart --id <group-id>
```

Switching is an operator action — run it from the host. Every provider uses the
same `memory/` tree, so memory carries across automatically. Run
`/migrate-memory` only when upgrading a group that still has legacy `.seed.md`,
`CLAUDE.local.md`, or unindexed imported memory.

### Default new groups to pi (optional)

New groups are created on the instance default (`DEFAULT_AGENT_PROVIDER` in
`.env`, or `claude` when unset). Installing this skill does NOT change that
default. Ask the operator before flipping it, then restart the host so it takes
effect. This affects only groups created afterward; per-group
`ncl groups config update --provider` still overrides in either direction.

## Operational notes

- The continuation token is the absolute path of the pi session file under
  `<workspace>/.pi/sessions` — it survives container restarts because the
  workspace is the RW volume. `/clear` works as usual.
- A resumed session whose first turn produces no assistant work and no error is
  treated as a dead continuation: one automatic fresh-session fallback per
  query, replaying the original prompt.
- `abort()` tears down in process (`session.abort()` + dispose) — there is no
  serve process tree to kill. Mid-turn `push()` rides pi's native follow-up
  queue.
- The memory hook runs on new-session openings only, fail-closed (a failed hook
  logs and skips injection, never kills the turn). pi compacts in place, so
  there is no post-compaction re-arm step.
- Slash commands stay XML-wrapped by the runner (`supportsNativeSlashCommands =
  false`): pi's native commands (`/compact`, `/theme`, …) are interactive-TUI
  semantics and unwanted headless.
- pi's native skills discovery is `~/.pi/agent/skills`, `~/.agents/skills`, and
  the project's `.agents/skills`; the host contract links the selected shared
  skills into both `.agents` views.

## Verify

```bash
grep -q "./pi.js" container/agent-runner/src/providers/index.ts && echo "container barrel: OK"
grep -q "./pi.js" src/providers/index.ts && echo "host barrel: OK"
grep -q "@earendil-works/pi-coding-agent" container/agent-runner/package.json && echo "agent-runner dep: OK"
grep -q PI_AGENT_DIR container/agent-runner/src/providers/pi.ts && grep -q PI_AGENT_DIR src/providers/pi.ts \
  && echo "host/container pair: OK"
grep -q gateway-managed container/agent-runner/src/providers/pi-auth.ts && echo "gateway placeholder: OK"
cd container/agent-runner && bun test --isolate src/providers/pi*.test.ts src/providers/mcp-to-pi.test.ts && cd -
```

A first end-to-end turn needs a gateway credential and a group switched to pi.
The definitive check that pi actually ran the turn is a `continuation:pi` row in
the session's `outbound.db` `session_state` table.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| First reply is `"The agent run failed."`; `session_state` shows `continuation:claude` | Provider switch never reached `container_configs` — the runner defaulted to claude | `ncl groups config update --provider pi --id <group>` + `ncl groups restart --id <group>` |
| Every turn fails with a model-auth error | No gateway credential for the selected provider | `pnpm exec tsx setup/index.ts --step provider-auth pi` (or `provider-auth codex` for ChatGPT) |
| Model calls fail with `401 access restricted`; the gateway log shows `forward: access restricted host=api.<provider>` | The saved secret is not granted to this agent group (OneCLI `secretMode: selective`) | Grant it (`PUT /v1/agents/<agentId>/grants/secrets/<secretId>` on OneCLI), then retry |
| pi logs "found no auth.json" | The group's `.pi-shared/` was removed or the group was created before this skill | Restart the group (re-prepares the file); the container rewrites placeholders on the next turn |
| `Unknown provider: pi. Registered: claude` | Barrels not wired in the running build | Re-run the install, then `./container/build.sh build` |
| Model requests blocked by the gateway | The model host is not declared | Use a supported provider, or add its host to the host contract's `modelDomains` and refresh |

To remove the provider, follow [REMOVE.md](REMOVE.md).
