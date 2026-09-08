---
name: add-opencode
description: Use OpenCode as an agent provider. OpenRouter, OpenAI, Google, DeepSeek, etc. via OpenCode config — not the Anthropic Agent SDK. Per group via `ncl groups config update --provider opencode`; host passes OPENCODE_* and XDG mount when spawning containers.
metadata:
  nanoclaw-provider: opencode
  nanoclaw-provider-label: OpenCode
  nanoclaw-provider-hint: Open-source provider router
  nanoclaw-provider-offered: 'false'
  nanoclaw-provider-image: local-required
---

# OpenCode agent provider

Install OpenCode as an optional NanoClaw runtime. The payload is included in this
skill; it needs no separate provider branch. It uses the upstream runtime,
instructions and host contracts. The host contract remains at
version 1; the container owns its non-secret ChatGPT placeholder file.

Apply this skill to install OpenCode, then authenticate with
`pnpm exec tsx scripts/opencode-auth.ts`. To refresh the runtime, reapply the
skill in refresh mode after backing up local payload edits. Authentication alone
leaves installed files and the container image alone. Backend defaults are installation-wide; model and
reasoning effort can be overridden per group through the existing container
configuration. Per-group backend/auth selection and structured channel attachment
transport are separate work.

## Install

Install and refresh require host contract version 1. The compatibility predicate
below guards every subsequent step, so an unsupported core receives no partial
payload or dependency changes. Update core first if it reports a missing prerequisite.

```nc:run effect:refresh capture:opencode_core_ready validate:^yes$
node -e "const fs=require('fs'); const p='src/provider-contracts/registry.ts'; if(fs.existsSync(p) && /PROVIDER_HOST_CONTRACT_SEAM_VERSION = 1/.test(fs.readFileSync(p,'utf8'))) console.log('yes'); else console.log('no')"
```

Copy every file under this skill's `payload/` to the matching path at the project
root. These are skill-owned files; overwrite them together when refreshing the
skill. Keep the core-owned `cwd-shim.ts`, registries, and contract realization
files in place.

```nc:copy when:opencode_core_ready=yes
payload/container/agent-runner/src/provider-contracts/opencode.ts -> container/agent-runner/src/provider-contracts/opencode.ts
payload/container/agent-runner/src/providers/mcp-to-opencode.test.ts -> container/agent-runner/src/providers/mcp-to-opencode.test.ts
payload/container/agent-runner/src/providers/mcp-to-opencode.ts -> container/agent-runner/src/providers/mcp-to-opencode.ts
payload/container/agent-runner/src/providers/opencode-config.ts -> container/agent-runner/src/providers/opencode-config.ts
payload/container/agent-runner/src/providers/opencode-managed-config/opencode/opencode.json -> container/agent-runner/src/providers/opencode-managed-config/opencode/opencode.json
payload/container/agent-runner/src/providers/opencode-managed-config/opencode/.gitignore -> container/agent-runner/src/providers/opencode-managed-config/opencode/.gitignore
payload/container/agent-runner/src/providers/opencode-memory-plugin.ts -> container/agent-runner/src/providers/opencode-memory-plugin.ts
payload/container/agent-runner/src/providers/opencode-memory.ts -> container/agent-runner/src/providers/opencode-memory.ts
payload/container/agent-runner/src/providers/opencode-registration.test.ts -> container/agent-runner/src/providers/opencode-registration.test.ts
payload/container/agent-runner/src/providers/opencode-turn.ts -> container/agent-runner/src/providers/opencode-turn.ts
payload/container/agent-runner/src/providers/opencode.attachments.test.ts -> container/agent-runner/src/providers/opencode.attachments.test.ts
payload/container/agent-runner/src/providers/opencode.compaction.test.ts -> container/agent-runner/src/providers/opencode.compaction.test.ts
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
payload/scripts/opencode-model-config.ts -> scripts/opencode-model-config.ts
payload/scripts/opencode-models.test.ts -> scripts/opencode-models.test.ts
payload/scripts/opencode-models.ts -> scripts/opencode-models.ts
payload/scripts/opencode-vault.test.ts -> scripts/opencode-vault.test.ts
payload/scripts/opencode-vault.ts -> scripts/opencode-vault.ts
payload/scripts/tsconfig.opencode-auth.json -> scripts/tsconfig.opencode-auth.json
payload/src/provider-contracts/opencode.ts -> src/provider-contracts/opencode.ts
payload/src/providers/opencode-auth-stub.ts -> src/providers/opencode-auth-stub.ts
payload/src/providers/opencode-registration.test.ts -> src/providers/opencode-registration.test.ts
payload/src/providers/opencode.ts -> src/providers/opencode.ts
```

Append `import './opencode.js';` once to each of the four provider and contract
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
pnpm exec vitest run src/providers/opencode-registration.test.ts scripts/opencode-auth*.test.ts scripts/opencode-models.test.ts scripts/opencode-vault.test.ts setup/providers
```

```nc:run effect:test when:opencode_core_ready=yes
cd container/agent-runner && bun test src/providers/opencode*.test.ts src/providers/mcp-to-opencode.test.ts
```

Build the local image with `./container/build.sh build`. The new SDK dependency
requires a full local build; a CLI-only overlay cannot supply it. This switches
a published-image installation to locally built images.

```nc:run effect:build when:opencode_core_ready=yes
./container/build.sh build
```

## Authenticate and select a group

After applying the skill and building its local image, run
`pnpm exec tsx scripts/opencode-auth.ts` from the project root to choose
authentication. This command leaves installed files and the image alone. Choose
ChatGPT sign-in, a local OpenAI-compatible endpoint, OpenRouter, DeepSeek, or a
supported native backend. Automatic API-key configuration supports OpenAI,
OpenRouter, DeepSeek, Google, and Anthropic; other native authentication schemes
require separate integration. The command stores credentials in OneCLI and backend defaults in
`.env`. The command leaves the instance default unchanged. Select OpenCode for
each group through the existing group configuration.

For ChatGPT, native OpenCode sign-in runs in a temporary container directory.
The OAuth credential is translated into OneCLI's supported vault format, and the
temporary native file is removed. The container initializes fixed
`onecli-managed` placeholders before every OpenCode server start at
`$XDG_DATA_HOME/opencode/auth.json`; tokens and account metadata stay in OneCLI.
API-key mode clears stale OAuth state. Refresh the payload and restart the host
service and affected containers when updating from the earlier read-only-bind
candidate; old containers retain their mounts until recreated.

Before using a group, grant its OneCLI agent access to the chosen secret.
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
continuation. The test requires a reachable backend and the correct OneCLI
secret grant. No provider is switched by the install steps alone. If memory
needs to move from another provider, follow `/migrate-memory` before switching.

## Recover a ChatGPT login

NanoClaw currently pins OneCLI 1.41.0, which cannot refresh these OAuth tokens
after expiry because its refresh request omits the required client ID. Use manual
reauthentication when that happens. Reliable unattended ChatGPT operation requires
a separately validated gateway refresh fix; upgrading to OneCLI 1.43.1 also
requires migrating its removed agent-grant API.

The container uses only the fixed sentinel; do not implement token refresh in the provider or copy live
credentials into a group. A saved credential is not proof that authentication
still works.

If a request fails because the login expired or was revoked, run on the host:

```bash
pnpm exec tsx scripts/opencode-auth.ts --reauth
# For a browser on the host instead of device pairing:
pnpm exec tsx scripts/opencode-auth.ts --reauth --method browser
```

This pairs again and updates the existing OneCLI secret ID, preserving its agent
permissions and all backend/model defaults. It uses NanoClaw's `ONECLI_URL` and
`ONECLI_API_KEY` management connection. If no credential exists, it creates one;
grant that new secret to the group as described above. Retry the failed request.

An unavailable vault, duplicate name, or incompatible credential entry stops the
operation before sign-in. Resolve the gateway/permissions or entry metadata in
OneCLI and retry; do not delete a credential to force setup to run. Failed
pairing leaves the old entry intact; failed saves leave defaults unchanged.
Temporary native credentials are removed after either success or failure.

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

Custom model limits and modalities apply only to the main model. MCP servers
come from the core's resolved runner configuration. Memory is rendered through
the shared hook on startup and after compaction, and routing reminders reuse
core wording for ordinary conversations and isolated tasks.

The managed container reads configuration from the payload's read-only
`opencode-managed-config` directory and the generated configuration supplied by
NanoClaw. It disables `.opencode` project configuration and plugin overrides;
configure models, permissions, and MCP through NanoClaw's existing surfaces.
The bundled local memory plugin has no package dependencies. Read-only
configuration prevents native OpenCode from installing its plugin-authoring
package at startup, so a fresh container needs no npm registry access. Session
data, caches, and memory remain writable. This applies only to the container;
host OpenCode keeps its native configuration and plugin support.

OpenCode keeps one server and continuously read event subscription per container.
Prompts are serialized and completion comes from the native prompt response plus
its stored messages. A stale idle event cannot complete a new turn. Failed or
uncertain turns are never automatically replayed. Aborts stop native execution;
if completion cannot be confirmed within the cleanup bound, the server is stopped
and the next query resumes from persisted state. Effective configuration changes
restart the shared server.

A local native plugin supplies the cached rendered memory and current core
instructions to every model request, including continuation after compaction.
It refreshes the memory snapshot in OpenCode's awaited compaction hook. A cold
resume reuses the persisted snapshot without running the startup hook. Task
children inherit their parent's context; their own compaction snapshots stay
separate. Renderer failure retains the last verified snapshot, while successful
empty output clears it.

Sessions created before this memory snapshot mechanism resume with current core
instructions. Their rendered memory is refreshed at the next compaction.
MCP calls allow 330 seconds, covering the core's five-minute human question
window plus transport overhead. Cancelling a turn cancels its active tool wait;
a question already posted to chat remains visible.

For reproducible native integration coverage, download the official OpenCode
1.18.25 binary and run from `container/agent-runner`:

```bash
OPENCODE_TEST_BINARY=/absolute/path/opencode bun test src/providers/opencode.native.test.ts
```

The test checks the binary version, starts a local model fixture, and exercises
native tools, automatic and overflow compaction, cold resume, child memory,
terminal errors, a 65-second MCP call, and cancellation. It writes its requests
and server logs to the temporary evidence directory printed at completion.
It takes about two minutes and requires no account credentials. The ordinary
test suite skips this check unless `OPENCODE_TEST_BINARY` is set.

To remove the provider, follow [REMOVE.md](REMOVE.md).
