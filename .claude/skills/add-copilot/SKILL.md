---
name: add-copilot
description: Use GitHub Copilot as a NanoClaw agent provider through the GitHub Copilot SDK. Device-login token stays in the credential gateway; containers send only a non-secret placeholder. Per group via `ncl groups config update --provider copilot`.
metadata:
  nanoclaw-provider: copilot
  nanoclaw-provider-label: GitHub Copilot
  nanoclaw-provider-hint: GitHub Copilot subscription through the credential gateway
  nanoclaw-provider-offered: 'true'
  nanoclaw-provider-image: local-required
---

# GitHub Copilot agent provider

Install GitHub Copilot as an optional NanoClaw runtime. The payload is included
in this skill; it needs no provider registry branch. It adds host and container
provider registrations, host/runtime provider contracts, a setup provider entry,
the Copilot login helper, the GitHub Copilot SDK, and the Copilot CLI manifest
entry used by the local agent image.

The credential boundary is the reason this provider exists: the GitHub Copilot
device-login token never enters the container. The container constructs
`CopilotClient` with a non-secret placeholder token, `useLoggedInUser: false`,
and `GH_TOKEN`, `GITHUB_TOKEN`, and `COPILOT_GITHUB_TOKEN` stripped from the SDK
environment. The selected credential gateway injects the real token only at the
network boundary: `Authorization: token {value}` for `api.github.com` path
`/copilot_internal/*`, and `Authorization: Bearer {value}` for the licensed
Copilot API host returned by GitHub.

The login helper is intentionally narrow. It supports OneCLI only and reads the
Copilot device-login token from the macOS keychain only; other gateways and
operating systems fail clearly. NanoClaw's gateway-neutral credential store
cannot yet express path-scoped grants for `api.github.com`, so this helper shells
to `onecli` for the two scoped secrets and the optional block rule. When that
store grows path scoping, this helper can move behind the neutral seam.

## Install

Copy only the files listed below from this skill's `payload/` directory to the
matching project-root paths. They are skill-owned files; overwrite them together
when refreshing the skill.

```nc:copy
payload/container/agent-runner/src/providers/copilot.ts -> container/agent-runner/src/providers/copilot.ts
payload/container/agent-runner/src/providers/copilot-mcp.ts -> container/agent-runner/src/providers/copilot-mcp.ts
payload/container/agent-runner/src/providers/copilot.test.ts -> container/agent-runner/src/providers/copilot.test.ts
payload/container/agent-runner/src/providers/copilot-registration.test.ts -> container/agent-runner/src/providers/copilot-registration.test.ts
payload/container/agent-runner/src/providers/copilot.conformance.test.ts -> container/agent-runner/src/providers/copilot.conformance.test.ts
payload/container/agent-runner/src/provider-contracts/copilot.ts -> container/agent-runner/src/provider-contracts/copilot.ts
payload/src/providers/copilot.ts -> src/providers/copilot.ts
payload/src/providers/copilot-registration.test.ts -> src/providers/copilot-registration.test.ts
payload/src/provider-contracts/copilot.ts -> src/provider-contracts/copilot.ts
payload/scripts/copilot-login.ts -> scripts/copilot-login.ts
payload/scripts/copilot-login.test.ts -> scripts/copilot-login.test.ts
payload/setup/providers/copilot.ts -> setup/providers/copilot.ts
payload/setup/providers/copilot.test.ts -> setup/providers/copilot.test.ts
```

Append the self-registration import to each provider, setup, and contract
barrel. Keep all existing imports.

```nc:append to:src/providers/index.ts
import './copilot.js';
```

```nc:append to:src/provider-contracts/index.ts
import './copilot.js';
```

```nc:append to:container/agent-runner/src/providers/index.ts
import './copilot.js';
```

```nc:append to:container/agent-runner/src/provider-contracts/index.ts
import './copilot.js';
```

```nc:append to:setup/providers/index.ts
import './copilot.js';
```

Install the pinned Copilot SDK in the runner's Bun package and add the pinned
Copilot CLI to the image manifest. Do not add `minimumReleaseAgeExclude` or
`onlyBuiltDependencies` entries.

```nc:dep manager:bun cwd:container/agent-runner
@github/copilot-sdk@1.0.14
```

```nc:json-merge into:container/cli-tools.json key:name
{"name":"@github/copilot","version":"1.0.85"}
```

Run the host build, runtime typecheck, provider contract verifier, host tests,
and Copilot provider tests.

```nc:run effect:build
pnpm run build
```

```nc:run effect:build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```

```nc:run effect:test
pnpm exec tsx scripts/provider-contract-verifier.ts --required-declared copilot
```

```nc:run effect:test
pnpm exec vitest run src/providers/copilot-registration.test.ts scripts/copilot-login.test.ts setup/providers/copilot.test.ts
```

```nc:run effect:test
cd container/agent-runner && bun test --isolate src/providers/copilot*.test.ts
```

Build the local image so the Copilot CLI and SDK are available to new provider
containers.

```nc:run effect:build
./container/build.sh build
```

## Authenticate

Run the Copilot login helper on the host:

```nc:run effect:external
pnpm exec tsx scripts/copilot-login.ts
```

The helper runs `copilot login` when no stored device-login token is available,
reads the token from the macOS keychain, asks GitHub which Copilot API endpoint
the account is licensed for, then configures OneCLI. It writes `COPILOT_API_URL`
to `.env`. For non-individual accounts it creates a OneCLI block rule for
`api.individual.githubcopilot.com`; for individual accounts it removes that
rule. Re-run with `--relogin` after refreshing the device login, or
`--login <github-login>` when the Copilot CLI config does not identify the
right account.

`api.github.com` is deliberately absent from the provider's `modelDomains`:
model domains are auto-approved host-wide, while this token must be scoped only
to `/copilot_internal/*` on that host.

## Use it

Per group:

```bash
ncl groups config update --id <group-id> --provider copilot
ncl groups restart --id <group-id>
```

Switching is an operator action; installing this skill does not change the
instance default provider. `COPILOT_MODEL` optionally overrides the selected
model; otherwise the provider requests `auto`, so the SDK chooses a model the
subscription allows. Memory, standing instructions, skills, MCP servers, mounts,
and workspace files come from NanoClaw's provider-neutral surfaces. Continuation
state is provider-specific, so a group starts a Copilot session when it first
wakes on this provider.

To remove the provider, follow [REMOVE.md](REMOVE.md).

## Troubleshooting

- **`Copilot gateway login supports OneCLI only`**: select the OneCLI gateway
  before running this provider's auth helper.
- **`Reading the Copilot device-login token is only supported from the macOS keychain`**:
  run the helper on macOS, or wait for a gateway-neutral path-scoped credential
  store.
- **Authentication fails inside the container**: re-run
  `pnpm exec tsx scripts/copilot-login.ts --relogin` on the host, then restart
  the affected group.
- **`Unknown provider: copilot`**: restart the NanoClaw host after installing so
  the provider barrels are loaded from the rebuilt host.
