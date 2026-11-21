---
name: add-antigravity
description: Use Google's Antigravity CLI (`agy`) as a full agent provider — Gemini models, built-in tools, MCP tools, conversation resume — alongside or instead of Claude. Gemini API key only (Google AI Studio or a paid Gemini API key), held by the credential gateway; no Google-account sign-in. Per-group via `ncl groups config update --provider antigravity`. Distinct from calling Gemini as an MCP tool (where Claude remains the planner).
metadata:
  nanoclaw-provider: antigravity
  nanoclaw-provider-label: Antigravity
  nanoclaw-provider-hint: Google Antigravity CLI — Gemini API key
  nanoclaw-provider-offered: 'true'
  nanoclaw-provider-image: local-required
---

# Antigravity agent provider

> Shortcut: `pnpm exec tsx setup/index.ts --step provider-auth antigravity` performs this whole install (payload files, barrels, Dockerfile block, image rebuild, host rebuild and restart) plus the API-key hand-off in one command. The steps below are the same operations, for agent-driven or manual application.

NanoClaw selects each group's agent backend from `container_configs.provider` (default `claude`). This skill installs the Antigravity provider: copy the payload from this skill's `payload/`, append one import to each of the five provider and contract barrels, append the Antigravity CLI block to `container/Dockerfile`, rebuild the image, then store a Gemini API key in the credential gateway.

## How it runs

Each query runs one long-lived `agy` process in the group's workspace, in headless stream-JSON mode (`--input-format stream-json --output-format stream-json --dangerously-skip-permissions`). NanoClaw writes one JSON line per user message to its stdin and reads agy's event stream back: tool steps become progress, each turn's `result` becomes the reply. The container's sandbox is the permission boundary, so agy runs without its interactive approvals.

- **Host contract:** the composed `AGENTS.md` (agy's project file), the per-group `.gemini-shared` state volume mounted at `~/.gemini`, and the two Google domains below. agy truncates a project file at about 24 KB, and the composed `AGENTS.md` is already close to that, so core trims it when extra modules or MCP instructions are added.
- **History:** agy keeps its history in a private database, so each exchange is also archived into the group's `conversations/` through core's shared exchange archive.
- **Settings:** before each query the provider merges three keys into `~/.gemini/antigravity-cli/settings.json` and keeps any others: `"modelProvider": "gemini"` (needed for API-key mode), `"enableTerminalSandbox": false` (agy's sandbox needs user namespaces, which Docker's default seccomp profile blocks; the container is the sandbox) and `"artifactReviewPolicy": "always-proceed"` (otherwise plans wait for a review nobody can give). agy rewrites the file at startup and drops keys left at their default, so the sandbox key may not appear there. The reasons are spelled out in `antigravity-config.ts`.
- **MCP:** the provider rewrites `~/.gemini/config/mcp_config.json` from the group's MCP servers, which agy calls through its built-in `call_mcp_tool`. The NanoClaw server entry carries `"timeoutSeconds": 330`, since agy's 180-second default is shorter than `ask_user_question`'s 300-second wait. Add servers with `ncl groups config add-mcp-server`; hand edits are overwritten.

**Instructions and memory.** agy has no system-prompt flag, and its own hooks do not run in Gemini API key mode ([google-antigravity/antigravity-cli#893](https://github.com/google-antigravity/antigravity-cli/issues/893), open). So before each agy process starts, the provider runs NanoClaw's memory hook itself and writes the output, with a short headless operating note, to the always-on rule file `~/.gemini/config/rules/nanoclaw.md`. That file is shared by every session of the group, so it holds only group-level content; the per-session NanoClaw instructions (chat or task mode, destinations) go in-band, as a `<nanoclaw_system_context>` block at the start of each agy process's first user turn. A resumed conversation accumulates these blocks; the newest one wins. Memory is read when agy starts, not refreshed mid-process. The runtime rewrites `nanoclaw.md` before every spawn; leave it alone. Your own rules can go beside it on the host, in `data/v2-sessions/<group-id>/.gemini-shared/config/rules/`; they are agy-only and do not carry across a provider switch.

**Resume.** The continuation is agy's conversation id, passed back as `--conversation <id>`. Conversation state lives in the group's `.gemini-shared` volume, so it survives container restarts. If agy no longer knows the id, it warns `conversation "<id>" not found` and starts a new conversation; the provider treats that as a fresh session and posts a short progress note. The earlier turns are then gone from the model's context.

## Why a Gemini API key, and nothing else

agy can also sign in with a personal Google account, but Google's Antigravity terms ([antigravity.google/terms](https://antigravity.google/terms) §6, restated by a Google maintainer in [google-antigravity/antigravity-cli#1493](https://github.com/google-antigravity/antigravity-cli/issues/1493)) do not allow that consumer OAuth login to be used from a third-party harness, and NanoClaw is one. So this provider offers no account sign-in. Use a key from Google AI Studio (https://aistudio.google.com/apikey). On a project with billing enabled, usage is charged at Gemini API rates; a free-tier key is not charged but is rate-limited. Either way it is separate from any Google One or Antigravity subscription.

The key never enters the container. Each Antigravity container gets `GEMINI_API_KEY=nc-antigravity-placeholder`, a non-secret marker agy needs only to start, and agy sends it as the `x-goog-api-key` header on every model call to `generativelanguage.googleapis.com`. agy honours the gateway's `HTTPS_PROXY` and CA, so the credential gateway selected by `NANOCLAW_GATEWAY_PROVIDER` swaps the placeholder for the real key on the wire. The key is never printed, passed in process arguments, or written to `.env`. Never put a key in chat.

agy also sends usage telemetry to `play.googleapis.com`, and version 1.5.8 cannot turn that off in headless API-key mode. The host contract therefore lists `play.googleapis.com` next to `generativelanguage.googleapis.com` as a model domain. Requests from antigravity groups to both domains pass without an approval prompt. With Iron Proxy, model domains also join its install-wide allowed hosts, so other groups can reach them too.

## Install

The mechanical steps under **Install** carry `nc:` directive fences: an agent reads the prose and applies them, and a parser can apply them deterministically from the same document. Every directive is idempotent, so the whole skill is safe to re-run; anything a parser can't apply falls back to the prose beside it.

### Pre-flight

Install and refresh require host contract version 1, credential-connection seam version 1 or later, core's shared exchange archive (`container/agent-runner/src/provider-contracts/exchange-archive.ts`), and the `nanoclaw:provider-binaries` marker region in `container/Dockerfile`. The compatibility predicate below guards every later step, so an unsupported core receives no partial payload or Dockerfile change. If it prints `no`, stop and tell the operator to run `/update-nanoclaw` first.

```nc:run effect:refresh capture:antigravity_core_ready validate:^yes$
node -e "const fs=require('fs'); const r=(f)=>fs.existsSync(f)?fs.readFileSync(f,'utf8'):''; if(/PROVIDER_HOST_CONTRACT_SEAM_VERSION = 1;/.test(r('src/provider-contracts/registry.ts')) && /PROVIDER_CREDENTIAL_CONNECTION_SEAM_VERSION = [1-9]/.test(r('setup/gateways/credential-store.ts')) && /export function archiveProviderExchange/.test(r('container/agent-runner/src/provider-contracts/exchange-archive.ts')) && r('container/Dockerfile').includes('<<< nanoclaw:provider-binaries')) console.log('yes'); else console.log('no')"
```

### 1. Copy the payload

Copy only the files listed below from this skill's `payload/` to the matching paths at the project root. These are skill-owned files; overwrite them together when refreshing the skill. The host files are the host contract, the env adapter (placeholder key, auto-update off), their guards, and the image block's structural and installer tests; the container files are the provider runtime, the stream-JSON protocol parser, the config writers, the runtime contract, and their guards, including the conformance test the verifier requires; the setup files are the picker entry and API-key walk-through; `container/install-antigravity.sh` is the pinned binary installer. The payload's two opt-in tests, `antigravity.native.test.ts` and `antigravity.gateway-proxy.test.ts`, are not copied; see **Opt-in tests**.

```nc:copy when:antigravity_core_ready=yes
payload/src/providers/antigravity.ts -> src/providers/antigravity.ts
payload/src/providers/antigravity-registration.test.ts -> src/providers/antigravity-registration.test.ts
payload/src/providers/antigravity-host-contribution.test.ts -> src/providers/antigravity-host-contribution.test.ts
payload/src/provider-contracts/antigravity.ts -> src/provider-contracts/antigravity.ts
payload/src/antigravity-dockerfile.test.ts -> src/antigravity-dockerfile.test.ts
payload/src/antigravity-installer.test.ts -> src/antigravity-installer.test.ts
payload/container/install-antigravity.sh -> container/install-antigravity.sh
payload/container/agent-runner/src/providers/antigravity.ts -> container/agent-runner/src/providers/antigravity.ts
payload/container/agent-runner/src/providers/antigravity-config.ts -> container/agent-runner/src/providers/antigravity-config.ts
payload/container/agent-runner/src/providers/antigravity-protocol.ts -> container/agent-runner/src/providers/antigravity-protocol.ts
payload/container/agent-runner/src/providers/antigravity-registration.test.ts -> container/agent-runner/src/providers/antigravity-registration.test.ts
payload/container/agent-runner/src/providers/antigravity.conformance.test.ts -> container/agent-runner/src/providers/antigravity.conformance.test.ts
payload/container/agent-runner/src/providers/antigravity.factory.test.ts -> container/agent-runner/src/providers/antigravity.factory.test.ts
payload/container/agent-runner/src/providers/antigravity.turns.test.ts -> container/agent-runner/src/providers/antigravity.turns.test.ts
payload/container/agent-runner/src/providers/antigravity.poll-loop.test.ts -> container/agent-runner/src/providers/antigravity.poll-loop.test.ts
payload/container/agent-runner/src/providers/antigravity-config.test.ts -> container/agent-runner/src/providers/antigravity-config.test.ts
payload/container/agent-runner/src/providers/antigravity-protocol.test.ts -> container/agent-runner/src/providers/antigravity-protocol.test.ts
payload/container/agent-runner/src/provider-contracts/antigravity.ts -> container/agent-runner/src/provider-contracts/antigravity.ts
payload/setup/providers/antigravity.ts -> setup/providers/antigravity.ts
payload/setup/providers/antigravity.test.ts -> setup/providers/antigravity.test.ts
payload/setup/providers/antigravity-registration.test.ts -> setup/providers/antigravity-registration.test.ts
```

### 2. Wire the barrels

Append `import './antigravity.js';` once to each of the five setup, provider, and contract barrels below. Keep all existing imports. Each barrel-registration test imports its real barrel and asserts `antigravity` is registered.

```nc:append to:src/providers/index.ts when:antigravity_core_ready=yes
import './antigravity.js';
```

```nc:append to:src/provider-contracts/index.ts when:antigravity_core_ready=yes
import './antigravity.js';
```

```nc:append to:container/agent-runner/src/providers/index.ts when:antigravity_core_ready=yes
import './antigravity.js';
```

```nc:append to:container/agent-runner/src/provider-contracts/index.ts when:antigravity_core_ready=yes
import './antigravity.js';
```

```nc:append to:setup/providers/index.ts when:antigravity_core_ready=yes
import './antigravity.js';
```

### 3. Install the Antigravity CLI in the image

agy is a native Go binary (about 265 MB), not an npm package, so it cannot go in `container/cli-tools.json`, which installs npm CLIs only. Google's own installer always fetches the newest release; `container/install-antigravity.sh` instead downloads one pinned build (1.5.8, execution id 4602374149505024), checks it with `sha512sum -c` against a hash pinned per architecture, refuses anything but amd64 and arm64, installs it as `/usr/local/bin/agy`, and fails the build unless `agy --version` prints the pinned version. `AGY_CLI_DISABLE_AUTO_UPDATE=true` stops agy replacing that binary at runtime (agy honours only the literal `true`). To move to a newer agy, change the version, the execution id and both sha512 sums in the script together, then rebuild the image.

Insert this block into `container/Dockerfile` once, inside core's `nanoclaw:provider-binaries` marker region, just above its `# <<< nanoclaw:provider-binaries` line (other skills' blocks may share the region). The region sits above the agent-runner and global-CLI layers, so a lockfile or Claude Code bump does not re-download agy, and the build there is still root, before core drops setuid bits and switches to the `node` user, so the block needs no `USER` lines. `ARG AGY_VERSION` is the pin the repo's pin inventory sees; the installer refuses to run if it differs from the version its hashes belong to. The installer picks the amd64 or arm64 build from `uname -m`, which reports the target platform in a native build and under emulation alike, and refuses any other architecture. Every line of the block is unique to this skill, so removing it never deletes a line another skill shares. `src/antigravity-dockerfile.test.ts` goes red if the block or the pins disappear, and `src/antigravity-installer.test.ts` runs the script against stubs.

```nc:append to:container/Dockerfile at:nanoclaw:provider-binaries when:antigravity_core_ready=yes
# ---- Antigravity CLI (add-antigravity) ----
ARG AGY_VERSION=1.5.8
COPY install-antigravity.sh /tmp/install-antigravity.sh
RUN AGY_REQUESTED_VERSION="${AGY_VERSION}" sh /tmp/install-antigravity.sh && rm /tmp/install-antigravity.sh
ENV AGY_CLI_DISABLE_AUTO_UPDATE=true
```

### 4. Build and test

```nc:run effect:build when:antigravity_core_ready=yes
pnpm run build
cd container/agent-runner && bun run typecheck
```

```nc:run effect:test when:antigravity_core_ready=yes
pnpm exec vitest run src/providers/antigravity-registration.test.ts src/providers/antigravity-host-contribution.test.ts src/antigravity-dockerfile.test.ts src/antigravity-installer.test.ts setup/providers
cd container/agent-runner && bun test --isolate src/providers/antigravity*.test.ts
```

```nc:run effect:test when:antigravity_core_ready=yes
pnpm exec tsx scripts/provider-contract-verifier.ts --required-declared antigravity
```

The verifier runs the host and runtime contract suites (registration and conformance) and checks that the two contract inventories agree. It goes red if a barrel line is missing, a barrel fails to evaluate, or the payload is broken. Then build the local image. The Dockerfile block needs a full local build; adding tools on top of a pulled image does not run it.

```nc:run effect:build when:antigravity_core_ready=yes
./container/build.sh build
```

## Authenticate

```nc:run effect:external when:antigravity_core_ready=yes
pnpm exec tsx setup/index.ts --step provider-auth antigravity
```

The same walk-through fresh installs get from the setup picker. It explains the API-key-only policy, links https://aistudio.google.com/apikey, and asks for the key in a local masked prompt. It refuses an empty key or one containing whitespace and accepts any key format Google issues (`AIza…`, `AQ.…`). The key goes straight to the credential gateway, as the `Antigravity Gemini API` connection. If the gateway already holds a usable key, it offers to keep or replace it (keeping it when no terminal is attached); if the stored key is registered for a different host, it asks before moving it. It finishes with the install check. To rotate the key, run the same command in a terminal on the NanoClaw host and choose **Replace**; existing grants are kept.

## Use it

After installing on a running host, restart it so it loads the Antigravity registration: `bash setup/lib/restart.sh` (the provider-auth shortcut already did this). A host on the old build does not know `antigravity`, and its groups fail on their first message. Then switch each group. A group switched from another provider keeps its stored model and effort, and agy receives them as-is: a Claude model id, or the install-wide `NANOCLAW_DEFAULT_MODEL` when the group has none, is not a Gemini model. Set an Antigravity slug, or an empty value so agy uses its own default, and do the same for effort:

```bash
ncl groups config update --id <group-id> --provider antigravity --model "" --effort ""
ncl groups restart --id <group-id>
```

Switching is an operator action — run it from the host. Every provider uses the same `memory/` tree, so memory carries across automatically. Run `/migrate-memory` only when upgrading a group that still has legacy `.seed.md`, `CLAUDE.local.md`, or unindexed imported memory. See [docs/provider-migration.md](../../docs/provider-migration.md). Send a message and check the reply. To test resume, run `ncl groups restart --id <group-id>`, then send a second message that depends on the first.

**Model and effort.** `--model` takes an agy model slug; the slug carries the reasoning effort in its name, for example `gemini-3.8-flash-medium`. Without a model, agy 1.5.8 uses `gemini-3.1-pro-preview`. `agy models` lists the slugs a key can use. `--effort` maps to agy's own `--effort` (`low`, `medium`, `high`, `xhigh` or `max`); leave it empty when the slug already names an effort. Any other value is dropped with a warning in the container log. agy has no speed setting, so `--speed` is not accepted for antigravity groups.

### Default new groups to antigravity (optional)

New groups are created on the **instance default** (`DEFAULT_AGENT_PROVIDER` in `.env`, or `claude` when unset). Installing this skill wires antigravity in but does NOT change that default — "installed" is not "authenticated", so the default stays claude until you opt in explicitly. After install, ask the operator before flipping it:

> "Antigravity is installed. Default new agent groups to antigravity? Existing groups keep their current provider."

On yes — set it, then restart the host service as in **Use it** above so it takes effect:

```bash
pnpm exec tsx setup/index.ts --step set-env -- --key DEFAULT_AGENT_PROVIDER --value antigravity
```

This affects only groups created afterward. Per-group `ncl groups config update --provider` still overrides the default in either direction. If `NANOCLAW_DEFAULT_MODEL` names a non-Gemini model, give each new antigravity group a model as above.

## Opt-in tests

Two payload tests run a real agy binary and are not copied by the install. They run agy on the host, so they need Linux (amd64 or arm64); on macOS run them inside a Linux container. `antigravity.native.test.ts` drives agy against a fake Gemini server with no key. `antigravity.gateway-proxy.test.ts` (also needs `openssl`) proves agy's model traffic goes through the gateway proxy carrying only the placeholder key. Extract agy 1.5.8 from the pinned tarball (URL and sha512 per architecture are at the top of `container/install-antigravity.sh`), check its hash, then run either test from a temporary copy:

```bash
curl -fsSL -o /tmp/agy.tar.gz <pinned-url> && echo "<pinned-sha512>  /tmp/agy.tar.gz" | sha512sum -c && tar -xzf /tmp/agy.tar.gz -C /tmp antigravity
T=antigravity.native.test.ts  # or antigravity.gateway-proxy.test.ts
cp .claude/skills/add-antigravity/payload/container/agent-runner/src/providers/$T container/agent-runner/src/providers/
cd container/agent-runner && AGY_TEST_BINARY=/tmp/antigravity bun test --isolate src/providers/$T; rm src/providers/$T
```

## Troubleshooting

- **Container dies at boot, channel silent:** `grep 'Container exited non-zero' logs/nanoclaw.error.log`; the `stderrTail` carries the reason. `Unknown provider: antigravity. Registered: claude` means the running build lacks the barrels: re-run the barrel step and `pnpm run build`, then `bash setup/lib/restart.sh`.
- **`agy: not found`:** the image predates the Dockerfile block. Check the block is in `container/Dockerfile`, inside the `nanoclaw:provider-binaries` region, run `./container/build.sh build` (a bare `build.sh` on a pulled-image install skips it), and restart the group.
- **Image build fails in `install-antigravity.sh`:** a `FAILED` from `sha512sum` means the download does not match the pin; retry, and never edit a hash to match an unverified download. `unsupported architecture` means the target is neither amd64 nor arm64. `the Dockerfile asks for agy …` means `ARG AGY_VERSION` was bumped without the script's pins.
- **Authentication notice on every message (401/403):** the gateway is not swapping in a working key. Run `pnpm exec tsx setup/index.ts --step provider-auth antigravity` in a terminal on the NanoClaw host, choose **Replace**, and check the key may call the Generative Language API in its Google Cloud project.
- **Model not found:** the group still has a Claude model id or `NANOCLAW_DEFAULT_MODEL`, the slug is misspelled, or the key's project cannot use that model. Set a slug, or `--model ""` for agy's default, and restart the group.
- **Effort ignored:** `Ignoring unsupported Antigravity effort` in the container log means the group carries another provider's value; set `low` to `max`, or `--effort ""`.
- **Gateway approval prompts for Google hosts:** the running host predates the Antigravity host contract. Restart it with `bash setup/lib/restart.sh`. Prompts for other hosts are ordinary gateway policy.
- **The agent lost earlier context after a restart:** the stored conversation was gone, so agy started a new one (see **Resume**). Check `data/v2-sessions/<group-id>/.gemini-shared/` exists and is writable by the container.
- **A turn fails with an error:** after a non-retryable Gemini API error (an HTTP 400, for example) agy reports an ERROR result and exits with code 3. Messages already queued behind that turn are not lost: the provider resumes the conversation in a new agy process once and sends them. Auth, quota and network failures show a fixed notice that says what to do, not agy's raw text; other failures show agy's error.

To remove the provider, follow [REMOVE.md](REMOVE.md).
