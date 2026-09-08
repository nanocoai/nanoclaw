# OpenCode host help and contract ownership

## Decision

OpenCode uses NanoClaw's existing setup and runtime hooks. The runtime host
contract stays at version 1. A separate versioned host-maintenance framework and
a read-only auth-file extension add shared machinery that this provider does not
need. Provider-specific implementation and acceptance fixes remain in the payload.

## Host help

After `/add-opencode` copies the payload, the installed setup entry registers
`offerFailureAssist`. It offers OpenCode, detects an existing CLI or offers the
pinned local installation, writes a private temporary diagnostic context file,
and launches the CLI in the checkout with its native permissions. The context
file is removed on return. A failed CLI exit does not establish that setup was
repaired; retry the failed step to verify it. The existing shared dispatcher calls this hook after the provider is selected
and its setup entry is registered. Its guarded Claude fallback is unchanged.
Explicit `?` help, early failures before registration, and saved-default routing
retain their existing core behavior; this payload does not extend those paths.

For standalone use after installation:

```bash
pnpm exec tsx scripts/opencode-host.ts --configure
pnpm exec tsx scripts/opencode-host.ts --debug
pnpm exec tsx scripts/opencode-host.ts --update
```

An existing `opencode` executable can also run directly in the checkout. It
natively discovers `.claude/skills`, including debugging and update instructions.
Host credentials and model configuration remain native to OpenCode, independent
of the container's OneCLI gateway. Existing native settings are preserved.

Before payload installation, automatic provider help would require an optional
pointer in setup metadata. This candidate does not add that extension. The
runtime provider contract does not need it.

## Container authentication

Before every `opencode serve` start, including a server restart in the same
container, the provider writes fixed `onecli-managed` placeholders to its own
session volume at `$XDG_DATA_HOME/opencode/auth.json`. No host auth-file bind or
host stub is required. Real tokens and account metadata stay in OneCLI.

The provider replaces the auth file atomically without following a file symlink.
API-key mode clears stale OAuth state before server startup. This file controls
native transport selection; making it read-only would prevent local edits but
would not isolate the gateway's credentials further.

When updating from the earlier candidate, run
`pnpm exec tsx setup/index.ts --step provider-auth opencode --refresh` and restart the
host service and affected agent containers together. A running container retains
its old bind mounts until recreated. The obsolete `data/opencode/openai-auth-stub.json`
file is no longer read; it may be removed separately after verifying that no old
container uses it. Host-native OpenCode auth files must be preserved.

## Container startup configuration

The generated container configuration is authoritative. The provider uses an
empty configuration directory shipped under the existing read-only `/app/src`
mount, while data, cache, and state remain writable. Native OpenCode skips npm
installation in read-only config directories; the local memory plugin has no
runtime package imports. Startup therefore does not need npm registry access.
`.opencode` project configuration is disabled in this managed container; model,
permission, and MCP settings come from NanoClaw. Host-native OpenCode configuration
and plugins are unaffected.

## Installation and refresh

An already installed provider's normal authentication command does not copy
files, fetch provider branches, or rebuild its image. `--refresh` explicitly
replaces skill-owned payloads and pins, verifies them, and rebuilds before auth.
Back up local payload edits before choosing refresh. Fresh installation uses the
existing engine's install mode, which preserves destinations already present.
The shared installer retains captured command output for compatibility predicates
and uses the existing portable Bun resolver.

## Custom model discovery

OpenAI-compatible custom endpoints ask whether a key is required before listing
models. A newly entered key is used as a bearer only for that configured models
request; redirects are refused. The key is saved in OneCLI only after model
selection succeeds, and provider defaults are saved after vaulting succeeds.

Keeping an existing key leaves the secret in OneCLI and offers manual model
entry. Re-entering the key enables discovery. A gateway reachability probe is a
separate potential enhancement. Neither behavior requires a core setup or
runtime contract extension.

## Verification limits

Tests cover placeholder initialization, backend switching, restart resets,
filesystem links, setup help, installation/refresh, and authenticated discovery.
A fixture model verifies adapter behavior, not live account entitlement or
OAuth renewal on the repository's gateway pin. Earlier real-account acceptance
results remain tied to their recorded revisions and gateway versions.
