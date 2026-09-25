---
name: add-opencode
description: Use OpenCode as an agent provider. OpenRouter, OpenAI, Google, DeepSeek, etc. via OpenCode config — not the Anthropic Agent SDK. Per group via `ncl groups config update --provider opencode`; host passes OPENCODE_* and XDG mount when spawning containers.
metadata:
  nanoclaw-provider: opencode
  nanoclaw-provider-label: OpenCode
  nanoclaw-provider-hint: Open-source provider router
  nanoclaw-provider-offered: 'true'
  nanoclaw-provider-image: local-required
---

# OpenCode agent provider

Install OpenCode as an optional NanoClaw runtime. The payload is included in this
skill; it needs no separate provider branch. It uses the upstream runtime,
instructions, host, and setup metadata contracts. The host contract remains at
version 1; the container owns its non-secret ChatGPT placeholder file.

OpenCode is offered by the standard setup provider picker. Existing installs can
add or authenticate it with `pnpm exec tsx setup/index.ts --step provider-auth opencode`.
To replace an installed payload and update its pins, append `--refresh`; back up
local payload edits first. Ordinary re-authentication leaves installed files and
the container image alone. Backend defaults are installation-wide; model and
reasoning effort can be overridden per group through the existing container
configuration. Per-group backend/auth selection and structured channel attachment
transport are separate work.

Authentication checks the installed files, registration lines, and exact pins
against this skill's declarations without launching a subprocess or container.
Install and refresh run the existing provider contract verification; the build
step owns image freshness. Model selection does not repeat installation checks.
A working backend and account are checked separately by sending a real request.

## Install

After installing this payload, run `pnpm exec tsx scripts/opencode-host.ts --configure`
for host OpenCode setup, or use `--update` / `--debug` for the corresponding
operational skill. An existing OpenCode CLI can also run directly in the checkout;
it discovers `.claude/skills` natively. Host sign-in uses OpenCode's own settings
and is independent of the container's gateway credentials. Installed setup failures
use the existing provider failure-assist hook, including wizard authentication
and installation-check failures. Host diagnostic context is model input and may
remain in native OpenCode history; deleting its private temporary file does not
erase those records. The helper requires stable OpenCode 1.18.25 or newer with
`--prompt` and prefers the newest compatible installation it finds.
`--debug`, `--update` and failure help launch it with an `OPENCODE_PERMISSION`
override: OpenCode asks before edits and before any command outside a short
read-only list. Debug sessions also deny stopping or removing containers and the
service; update sessions leave those steps to the update skill, behind a prompt.
`--configure` keeps OpenCode's native permissions.
Automatic help before payload
installation is optional and is not part of the runtime contract.

Install and refresh require host contract version 1 and credential-connection
seam version 1. The compatibility predicate
below guards every subsequent step, so an unsupported core receives no partial
payload or dependency changes. Update core first if it reports a missing prerequisite.

```nc:run effect:refresh capture:opencode_core_ready validate:^yes$
node -e "const fs=require('fs'); const p='src/provider-contracts/registry.ts', g='setup/gateways/credential-store.ts'; if(fs.existsSync(p) && /PROVIDER_HOST_CONTRACT_SEAM_VERSION = 1/.test(fs.readFileSync(p,'utf8')) && fs.existsSync(g) && /PROVIDER_CREDENTIAL_CONNECTION_SEAM_VERSION = 1/.test(fs.readFileSync(g,'utf8'))) console.log('yes'); else console.log('no')"
```

Copy only the files listed below from this skill's `payload/` to the matching
paths at the project root. Do not copy ignored dependency directories or other
generated native-test files. These are skill-owned files; overwrite them together
when refreshing the skill. Keep the core-owned `cwd-shim.ts`, registries, and
contract realization files in place.

When refreshing an older installation, remove its unused
`opencode-memory-plugin.ts`, `opencode.compaction.test.ts`, and dedicated
`opencode-managed-config` tree from `container/agent-runner/src/providers/`.
Recreate affected containers after the refresh to discard their old config
symlinks. Keep other tools' settings and persisted session data.

The obsolete host Dockerfile guard must also be removed during refresh; current
OpenCode installation is declared by the SDK and CLI manifests.

```nc:run effect:refresh when:opencode_core_ready=yes
rm -f src/opencode-dockerfile.test.ts
```

```nc:copy when:opencode_core_ready=yes
payload/container/agent-runner/src/provider-contracts/opencode.ts -> container/agent-runner/src/provider-contracts/opencode.ts
payload/container/agent-runner/src/providers/mcp-to-opencode.test.ts -> container/agent-runner/src/providers/mcp-to-opencode.test.ts
payload/container/agent-runner/src/providers/mcp-to-opencode.ts -> container/agent-runner/src/providers/mcp-to-opencode.ts
payload/container/agent-runner/src/providers/opencode-config.ts -> container/agent-runner/src/providers/opencode-config.ts
payload/container/agent-runner/src/providers/opencode-memory.ts -> container/agent-runner/src/providers/opencode-memory.ts
payload/container/agent-runner/src/providers/opencode-registration.test.ts -> container/agent-runner/src/providers/opencode-registration.test.ts
payload/container/agent-runner/src/providers/opencode-turn.ts -> container/agent-runner/src/providers/opencode-turn.ts
payload/container/agent-runner/src/providers/opencode.attachments.test.ts -> container/agent-runner/src/providers/opencode.attachments.test.ts
payload/container/agent-runner/src/providers/opencode.config.test.ts -> container/agent-runner/src/providers/opencode.config.test.ts
payload/container/agent-runner/src/providers/opencode.conformance.test.ts -> container/agent-runner/src/providers/opencode.conformance.test.ts
payload/container/agent-runner/src/providers/opencode.empty-resume.test.ts -> container/agent-runner/src/providers/opencode.empty-resume.test.ts
payload/container/agent-runner/src/providers/opencode.factory.test.ts -> container/agent-runner/src/providers/opencode.factory.test.ts
payload/container/agent-runner/src/providers/opencode.memory.test.ts -> container/agent-runner/src/providers/opencode.memory.test.ts
payload/container/agent-runner/src/providers/opencode.native.test.ts -> container/agent-runner/src/providers/opencode.native.test.ts
payload/container/agent-runner/src/providers/opencode.question.test.ts -> container/agent-runner/src/providers/opencode.question.test.ts
payload/container/agent-runner/src/providers/opencode.shared-runtime.test.ts -> container/agent-runner/src/providers/opencode.shared-runtime.test.ts
payload/container/agent-runner/src/providers/opencode.sse-cleanup.test.ts -> container/agent-runner/src/providers/opencode.sse-cleanup.test.ts
payload/container/agent-runner/src/providers/opencode.ts -> container/agent-runner/src/providers/opencode.ts
payload/container/agent-runner/src/providers/opencode-auth.ts -> container/agent-runner/src/providers/opencode-auth.ts
payload/container/agent-runner/src/providers/opencode-auth.test.ts -> container/agent-runner/src/providers/opencode-auth.test.ts
payload/scripts/opencode-auth-config.test.ts -> scripts/opencode-auth-config.test.ts
payload/scripts/opencode-auth.test.ts -> scripts/opencode-auth.test.ts
payload/scripts/opencode-auth.ts -> scripts/opencode-auth.ts
payload/scripts/opencode-gateway.test.ts -> scripts/opencode-gateway.test.ts
payload/scripts/opencode-host.ts -> scripts/opencode-host.ts
payload/scripts/opencode-host.test.ts -> scripts/opencode-host.test.ts
payload/scripts/opencode-model-config.ts -> scripts/opencode-model-config.ts
payload/scripts/opencode-models.test.ts -> scripts/opencode-models.test.ts
payload/scripts/opencode-models.ts -> scripts/opencode-models.ts
payload/scripts/opencode-vault.test.ts -> scripts/opencode-vault.test.ts
payload/scripts/opencode-vault.ts -> scripts/opencode-vault.ts
payload/scripts/tsconfig.opencode-auth.json -> scripts/tsconfig.opencode-auth.json
payload/setup/providers/opencode.test.ts -> setup/providers/opencode.test.ts
payload/setup/providers/opencode.ts -> setup/providers/opencode.ts
payload/src/provider-contracts/opencode.ts -> src/provider-contracts/opencode.ts
payload/src/providers/opencode-auth-stub.ts -> src/providers/opencode-auth-stub.ts
payload/src/providers/opencode-registration.test.ts -> src/providers/opencode-registration.test.ts
payload/src/providers/opencode.ts -> src/providers/opencode.ts
```

Append `import './opencode.js';` once to each of the five setup, provider, and contract
barrels below. Keep all existing imports.

```nc:append to:src/providers/index.ts when:opencode_core_ready=yes
import './opencode.js';
```

```nc:append to:src/provider-contracts/index.ts when:opencode_core_ready=yes
import './opencode.js';
```

```nc:append to:container/agent-runner/src/providers/index.ts when:opencode_core_ready=yes
import './opencode.js';
```

```nc:append to:container/agent-runner/src/provider-contracts/index.ts when:opencode_core_ready=yes
import './opencode.js';
```

```nc:append to:setup/providers/index.ts when:opencode_core_ready=yes
import './opencode.js';
```

Install the SDK in the runner's Bun package and add the matching CLI manifest
entry with trusted postinstall enabled. Both pins must remain exactly 1.18.25. When refreshing an existing install,
replace both old pin entries; presence alone does not establish compatibility.
This updates the runner package and lockfile; there is no host SDK dependency.

```nc:dep manager:bun cwd:container/agent-runner when:opencode_core_ready=yes
@opencode-ai/sdk@1.18.25
```

```nc:json-merge into:container/cli-tools.json key:name when:opencode_core_ready=yes
{"name":"opencode-ai","version":"1.18.25","onlyBuilt":true}
```

Run the host build, runner typecheck, host/auth tests, and all provider tests.
The tests exercise real barrel registration and the provider-owned contract
conformance suite. All checks must pass before rebuilding the agent image.

```nc:run effect:build when:opencode_core_ready=yes
pnpm run build
```

```nc:run effect:build when:opencode_core_ready=yes
pnpm exec tsc -p scripts/tsconfig.opencode-auth.json
```

```nc:run effect:build when:opencode_core_ready=yes
cd container/agent-runner && bun run typecheck
```

```nc:run effect:test when:opencode_core_ready=yes
pnpm exec vitest run src/providers/opencode-registration.test.ts scripts/opencode-auth*.test.ts scripts/opencode-gateway.test.ts scripts/opencode-host.test.ts scripts/opencode-models.test.ts scripts/opencode-vault.test.ts setup/providers
```

```nc:run effect:test when:opencode_core_ready=yes
cd container/agent-runner && bun test --isolate src/providers/opencode*.test.ts src/providers/mcp-to-opencode.test.ts
```

Build the local image with `./container/build.sh build`. The new SDK dependency
requires a full local build; a CLI-only overlay cannot supply it. This switches
a published-image installation to locally built images.

```nc:run effect:build when:opencode_core_ready=yes
./container/build.sh build
```

## Authenticate and select a group

Run `pnpm exec tsx setup/index.ts --step provider-auth opencode` from the project
root to install a missing payload and image, then choose authentication. If the
provider is already installed, this command leaves its files and image alone;
append `--refresh` only when intentionally replacing its payload and pins. Choose
ChatGPT sign-in, a local OpenAI-compatible endpoint, OpenRouter, DeepSeek, or a
supported native backend. Automatic API-key configuration supports OpenAI,
OpenRouter, DeepSeek, Google, and Anthropic; other native authentication schemes
require separate integration. The command stores credentials in the configured
credential gateway selected by `NANOCLAW_GATEWAY_PROVIDER` and backend defaults in
`.env`. The full setup wizard also offers this flow and selects OpenCode for
new groups only after configuration succeeds. The standalone command leaves the
instance default unchanged.

For ChatGPT, native OpenCode sign-in runs in a temporary container directory.
OpenCode parses its own login file into the seam's `chatgpt` OAuth profile, hands
it to the selected gateway, and removes the temporary native file. Iron Control stores its refresh token in a native OAuth broker
using OpenCode's own public OAuth client; a separate granted secret supplies the
account header. Setup waits for Iron's native broker to mint a fresh access token
before continuing; this can take up to two minutes. OneCLI translates the same result to its native credential format. The container initializes fixed
`nc-opencode-token-v1` placeholders before every OpenCode server start at
`$XDG_DATA_HOME/opencode/auth.json`; tokens and account metadata stay in the gateway.
API-key mode clears stale OAuth state. Refresh the payload and restart the host
service and affected containers when updating from the earlier read-only-bind
candidate; old containers retain their mounts until recreated.

With Iron Proxy, setup grants both the model credential and any account header
to this installation’s principal. It reconciles the destination allowlist without
installing OneCLI or reading `ONECLI_URL` / `ONECLI_API_KEY`. Native model domains
and the configured HTTPS model host belong to OpenCode’s provider contract.
Iron endpoints must use HTTPS on port 443 with a DNS hostname, including keyless
self-hosted models; put TLS in front of a plaintext local server first.

With the OneCLI gateway selected, grant the group’s OneCLI agent access to the chosen secret.
Read its existing secret assignments first and merge the new secret ID into that
list: `onecli agents set-secrets` replaces assignments. Verify the result with
`onecli agents secrets`. Do not put a key in `.env`, command arguments, or the
container environment.

After installing on a running NanoClaw host, restart its actual host service
before waking any OpenCode group. This reloads the host provider registration and
backend settings. On Linux use `systemctl --user restart nanoclaw-v2-<install-slug>.service`
(or the installation's system service command); on macOS use its normal launchd
restart workflow. Confirm the service is running, then select and restart the
test group:

```bash
ncl groups config update --id <group-id> --provider opencode
ncl groups restart --id <group-id>
```

Send a message and verify a reply, then send a second message to check session
continuation. The test requires a reachable backend and the correct gateway
secret grant. No provider is switched by the install steps alone. If memory
needs to move from another provider, follow `/migrate-memory` before switching.

## Recover a ChatGPT login

OAuth refresh belongs to the credential gateway. Installs using OneCLI 1.41.0
require manual reauthentication after expiry; see [OneCLI compatibility](ONECLI-LEGACY.md)
for the version-specific limitation and upgrade constraints.

The container uses only a fixed sentinel. Do not implement token refresh in the
provider or copy live credentials into a group. A saved credential is not proof
that authentication still works.

If a request fails because the login expired or was revoked, run on the host:

```bash
pnpm exec tsx scripts/opencode-auth.ts --reauth
# For a browser on the host instead of device pairing:
pnpm exec tsx scripts/opencode-auth.ts --reauth --method browser
```

This pairs again and updates the existing gateway credential ID, preserving
its grants and all backend/model defaults. Iron also retains the existing broker
and account-header IDs and resets a dead broker with the new refresh token.
Only a selected OneCLI adapter uses `ONECLI_URL` and `ONECLI_API_KEY`. If no
credential exists, setup creates one and applies the gateway’s grant behavior
described above. Retry the failed request.

An unavailable vault, duplicate name, or incompatible credential entry stops the
operation before sign-in. Resolve the gateway/permissions or entry metadata in
the selected gateway and retry; do not delete a credential to force setup to run. Failed
pairing leaves the old entry intact; failed saves leave defaults unchanged.
Temporary native credentials are removed after either success or failure.

API-key rotation keeps the same credential ID. Changing its exact host requires
confirmation. Iron’s update API replaces the secret source when changing rules,
so a host change also requires re-entering the key; a blank answer can only keep
a key on its existing host. Setup never retrieves the stored key.

## Change or refresh the default model

Run `pnpm exec tsx scripts/opencode-models.ts` to keep the current default or
choose another model without signing in again. This changes only
`OPENCODE_MODEL`; the small model, endpoint, credentials, and group overrides
stay as configured. Restart the NanoClaw host and affected groups afterward.

```bash
pnpm exec tsx scripts/opencode-models.ts --list --refresh
pnpm exec tsx scripts/opencode-models.ts --model openai/<model-id>
```

Discovery runs the installed container's `opencode models` command and filters
for text and tool support, including its ChatGPT-specific filter when selected.
Only a disposable fixed sentinel is used for that filter; no credentials or host
OpenCode files are mounted for discovery. `--refresh` fetches the runtime's
current model catalog; it does not upgrade the CLI or SDK. Account access is checked by a real
request, not by catalog membership. Standalone host OpenCode is never consulted.
If discovery is unavailable, keep the existing model or enter an id manually.
There is no static fallback list. A custom OpenAI-compatible endpoint is queried
through its own `/models` endpoint; other custom endpoints use manual IDs.
The configured backend must match the model prefix; changing backends still
uses the authentication command. Exported defaults take precedence over `.env`,
so conflicting exported values must be cleared before changing the saved model.

This separate command avoids rerunning authentication merely to change a model,
and querying the container avoids disagreement with a separately upgraded host
CLI. New models needing newer runtime support require a matched CLI/SDK update
and image rebuild. Model changes do not automatically change context limits or
modalities; adjust any custom overrides to match the new model.

## Backend defaults

The host reads these values from exported environment variables, then `.env`.
Put comments on separate lines. These settings affect only OpenCode containers.

- `OPENCODE_PROVIDER`: OpenCode backend ID, such as `openai` or `openrouter`.
- `OPENCODE_MODEL`: default full `provider/model` ID. The group's model wins.
- `OPENCODE_SMALL_MODEL`: optional separate model for lighter work, using the same backend prefix as `OPENCODE_PROVIDER`.
- `OPENCODE_BASE_URL`: backend URL, or `native` to use the native endpoint.
  For an `openai` backend with a custom URL, the runtime uses Chat Completions.
  An absent setting retains the historical `ANTHROPIC_BASE_URL` fallback for
  existing installs. The auth command writes this provider-owned setting and
  preserves Claude's endpoint.
- `OPENCODE_AUTH_MODE=chatgpt`: initialize the container's non-secret ChatGPT stub. Leave unset for
  API-key and local endpoints; the auth command handles this when switching.
- `OPENCODE_MODEL_CONTEXT_LIMIT`: positive token count for the main model.
- `OPENCODE_MODEL_OUTPUT_LIMIT`: positive output limit, requiring a context limit.
- `OPENCODE_MODEL_INPUT_MODALITIES`: optional comma-separated main-model input
  types from `text,audio,image,video,pdf`.
- `OPENCODE_NATIVE_ATTACHMENT_MAX_COUNT` / `OPENCODE_NATIVE_ATTACHMENT_MAX_BYTES`:
  optional limits for already-staged structured attachments. Upstream channel
  attachment transport remains text-only until that separate feature lands.

Custom model limits and modalities apply only to the main model. NanoClaw supplies
MCP configuration and container policy. See [ARCHITECTURE.md](ARCHITECTURE.md) for
turn completion, memory snapshots, offline startup, cancellation, and MCP timeouts.

For reproducible native integration coverage, download the official OpenCode
1.18.25 binary and run from `container/agent-runner`:

```bash
OPENCODE_TEST_BINARY=/absolute/path/opencode bun test --isolate src/providers/opencode.native.test.ts
```

The test checks the binary version, starts a local model fixture, and exercises
native tools, automatic and overflow compaction, cold resume, child memory,
terminal errors, a 65-second MCP call, and cancellation. It writes its requests
and server logs to the temporary evidence directory printed at completion.
It takes about two minutes and requires no account credentials. The ordinary
test suite skips this check unless `OPENCODE_TEST_BINARY` is set.

To remove the provider, follow [REMOVE.md](REMOVE.md).
