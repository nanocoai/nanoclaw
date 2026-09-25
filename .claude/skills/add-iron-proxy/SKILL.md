---
name: add-iron-proxy
description: Install or refresh Iron Proxy and its official Iron Control web console for NanoClaw. Use when selecting the Iron gateway, adding its management UI, configuring credentials and grants, or restoring the proxy, approval bridge, and agent guidance.
---

# Add Iron Proxy gateway

Install the official `iron-control` console and PostgreSQL alongside one central Iron Proxy. NanoClaw core supplies the generic gateway seam and human approval flow. Read `docs/gateway-seam.md` before changing the integration.

Use the bundled setup scripts and the source revisions in `versions.json`. The console is the upstream Rails application; its UI is not generated or copied into NanoClaw. This is a local Docker installation. Reuse this copy's recorded services and keys when refreshing it.

## Install the provider payload

Copy the package's provider, approval middleware, tests, and agent guidance into their normal NanoClaw paths.

```nc:copy
payload/src/gateway-providers/iron-proxy.ts -> src/gateway-providers/iron-proxy.ts
payload/src/gateway-providers/iron-proxy.test.ts -> src/gateway-providers/iron-proxy.test.ts
payload/src/gateway-providers/iron-proxy-approval.ts -> src/gateway-providers/iron-proxy-approval.ts
payload/src/gateway-providers/iron-proxy-approval.test.ts -> src/gateway-providers/iron-proxy-approval.test.ts
payload/src/gateway-providers/iron-proxy-transform.proto -> src/gateway-providers/iron-proxy-transform.proto
payload/container/skills/iron-proxy-gateway/SKILL.md -> container/skills/iron-proxy-gateway/SKILL.md
payload/container/skills/iron-proxy-gateway/instructions.md -> container/skills/iron-proxy-gateway/instructions.md
```

## Register once

The provider file makes the only product registration call. It declares idempotent sessions, typed runtime contributions, owned-resource cleanup, normalized approvals, network access, and agent guidance. NanoClaw core owns approval persistence, cards, clicks, authorization, and timeouts.

```nc:append to:src/gateway-providers/installed.ts
import './iron-proxy.js';
```

## Install the bridge dependencies

```nc:dep manager:pnpm
@grpc/grpc-js@1.14.4
@grpc/proto-loader@0.8.1
```

## Install the console and pinned proxy

Setup pulls the pinned official Iron Control image and database image, starts them on a dedicated Docker network, creates a local operator account, and registers this copy's proxy and principal through Iron's API. It stores credentials and encryption keys in owner-only files under `data/session-materials/iron-control/`. The database has its own persistent volume and no published port. Neither the console credentials nor its database are mounted into agents.

The installer streams stage names and elapsed-time updates. Source downloads stop after two minutes, the image build after twenty minutes, and console startup after six minutes. It never opens a Git credential prompt. The proxy is built locally from the pinned public upstream source, so installation does not require a GitHub account or access to a private proxy image. The console and build dependencies use their pinned public images. On failure, fix the reported access or service issue and rerun setup; keep existing database volumes and encryption keys together. Raw subprocess output is not streamed because it can contain credentials.

Setup builds unmodified upstream Iron Proxy and a separate NanoClaw approval front in the same image. No Iron fork or source patch is used. The front is the only network-facing listener. It authenticates session identities, inspects each HTTP request inside HTTPS tunnels, checks the allowlist, and waits for an explicit approval before forwarding to Iron on `127.0.0.1:18080`. Empty, malformed, rejected or timed-out decisions fail closed. Iron's own dial-time loopback and link-local deny rules prevent DNS aliases from reaching the internal backend. Managed control-plane updates only change Iron's credential transforms; they cannot remove the front's checks.

The front builds and runs the pinned OneCLI helper in `gateway-compat/onecli-summary`; do not add app-specific rules. Only method, host, path, response status and the resulting OneCLI summary reach the approval bridge. Raw bodies, authorization headers, query strings and Iron transform traces do not. The helper sees a bounded pre-injection body prefix; the full original stream is preserved. Read the approval-presentation contract in `docs/gateway-seam.md`. The build tests stock Iron, the front, and the summary helper, then records an immutable image ID and source hash.
NanoClaw's approval service uses a private Unix socket on Linux. On macOS it uses loopback with mutual TLS and a proxy-only client certificate. Credentials pass directly from Iron Control to Iron Proxy.

`NANOCLAW_IRON_PROXY_PORT` in `.env` sets the internal proxy port (default `8080`). Setup uses the same value for the front listener and the agent proxy URL. This does not publish a host port. Re-run setup and restart this NanoClaw copy after changing it.

`NANOCLAW_IRON_CONTROL_PORT` sets the console port (default `10257`). Only `127.0.0.1` is published. Set it before setup if another install uses that port; use the URL printed by setup.

### Architectures

The pinned official Iron Control image exists for `linux/amd64` only. Setup checks the Docker engine's architecture before it pulls anything:

- **amd64**: the pinned image and digest, unchanged.
- **Any other architecture (arm64 Linux hosts, Apple Silicon)**: setup builds Iron Control from the pinned upstream revision on this machine with Docker Buildx, tags it `nanoclaw-iron-control:<revision>-<arch>`, and runs it natively with `platform:` set to the engine's own (several minutes on first install; later runs reuse the image). Without Buildx it keeps the pinned amd64 image under QEMU emulation when the engine can run amd64 containers. When it can do neither, it stops before any pull and names the options: enable emulation with `docker run --privileged --rm tonistiigi/binfmt --install amd64`, or choose the OneCLI gateway. Setup never registers emulation on its own; the wizard runs the step without a terminal, so that command is yours to run. Running `setup.ts --with-control` from a terminal asks first.

The choice is recorded in `data/session-materials/iron-control/image.json` and reused by later setup runs and `/update-nanoclaw`; an install that already ran the pinned image under emulation keeps doing so while emulation works. To decide again, delete `image.json` and `compose.yaml` from that directory and re-run setup: both are rewritten, and the keys and database are kept. This check runs before setup builds Iron Proxy, so a host that can neither build nor emulate stops within seconds.

```nc:run effect:step
pnpm exec tsx .claude/skills/add-iron-proxy/scripts/setup.ts --with-control
```

## Troubleshooting

- **Source access fails:** verify the pinned source is readable from this machine.
  The installer uses the public source in `versions.json` and disables interactive
  Git prompts. Check connectivity and the pinned revision, then retry.
- **A command times out:** use the last printed stage to identify whether source
  download, image build, or console startup failed. Check connectivity and Docker
  health before retrying. The installer terminates the timed-out process group.
- **The database exists but keys are missing:** restore its matching `control.env`.
  Keep the database volume and encryption keys together; do not generate replacement
  keys for an existing database.
- **`exec format error` or "has no arm64 image" at the Iron Control step:** this
  engine is not amd64 and the pinned console image only exists for amd64. Install
  Docker Buildx so setup builds the console here, or enable emulation with
  `docker run --privileged --rm tonistiigi/binfmt --install amd64`, or choose the
  OneCLI gateway; then re-run setup. See [Architectures](#architectures).

## Validate

```nc:run effect:build
pnpm run build
```

```nc:run effect:test
pnpm exec vitest run src/gateway-providers/iron-proxy.test.ts src/gateway-providers/iron-proxy-approval.test.ts src/gateway-providers/gateway-provider-registry.test.ts src/gateway-approval-coordinator.test.ts .claude/skills/add-iron-proxy/scripts/control.test.ts .claude/skills/add-iron-proxy/scripts/control-image.test.ts .claude/skills/add-iron-proxy/scripts/provider-credentials.test.ts .claude/skills/add-iron-proxy/scripts/credential-isolation.test.ts .claude/skills/add-iron-proxy/scripts/install-command.test.ts
```

The setup consumer writes `NANOCLAW_GATEWAY_PROVIDER=iron-proxy` only after every directive succeeds. Restart only this copy's NanoClaw service after an upgrade so its session contribution and approval bridge match the new installation. Check the proxy has synced its assigned principal before reporting the gateway ready.

The request order is front identity and allowlist → human approval → stock Iron credentials → upstream. The front also requires an explicit response decision before returning upstream data. HTTPS tunnels pin the target authority; each inner HTTP request is checked again. Streaming responses and WebSocket upgrades use this same request/response gate. Credentialed application requests use HTTPS; the approval bridge rejects plaintext HTTP destinations. Do not rewrite an HTTP request’s approval metadata as HTTPS to bypass that restriction. The bridge forwards every allowed HTTP request to core as a default approval request. Core uses the active agent provider’s model-domain declaration to permit model traffic without a card; other destinations retain human approval. CONNECT verifies identity; the inner HTTP request is the approval point. Existing standalone model credentials are moved into Iron Control during setup and removed from the old secret file after successful storage and grant.

## Open and use the official console

Open the URL printed by setup. Give the operator the path to `login.txt` in the same private directory; keep passwords and API tokens out of chat and command logs. `control.ts status` prints only the URL and login-file location.

The pinned console provides **Secrets**, **Credentials**, **OAuth Apps**, and **Principals**. Use Secrets to create a credential, choose its source, and set its host, method, and path rules. The current console shows principals and grants but creates grants through its API. Apply a secret to this NanoClaw copy with the bundled helper:

```bash
pnpm exec tsx .claude/skills/add-iron-proxy/scripts/control.ts grant static <secret-id>
```

Other supported kinds are `gcp`, `aws`, `oauth`, `postgres`, and `hmac`. The command only grants an existing credential to this install's recorded principal. Read [references/control-plane.md](references/control-plane.md) for the exact supported UI, source links, policy example, and verification steps.

The pinned source has no general egress Policies screen or audit search. Do not promise the screens shown in newer or hosted documentation. A grant's request rules govern credential use; the local egress allowlist remains separate.

To allow another destination explicitly, the operator runs:

```bash
pnpm exec tsx .claude/skills/add-iron-proxy/scripts/setup.ts --allow-host <hostname-or-*.domain>
```

For a standalone proxy without the console, omit `--with-control` on a fresh install. A recorded console is preserved on refresh. Both modes build the pinned public source. To reuse an independently built image, build the exact commit from `versions.json`
and label the image `org.opencontainers.image.revision` with that commit. Then run
`pnpm exec tsx .claude/skills/add-iron-proxy/scripts/setup.ts --local-image <image>`.
Setup checks the revision and records the immutable local image ID. All installs require the exact bundled approval-front label; a stock Iron image alone is not the full NanoClaw integration.

## Codex authentication

Use the existing provider-auth entry point after `/add-codex` installs the
provider. Browser sign-in, device pairing, and API-key entry are the same for
all gateways; `scripts/credential-store.ts` supplies Iron's custody adapter.
Iron Control stores API keys and manages subscription refresh-token rotation
through its native broker. Agents receive only a synthetic `auth.json` file.
A subscription login uses a new, dedicated Codex session; never copy personal
Codex credentials. The setup flow and provider picker stay unchanged.

```bash
pnpm exec tsx setup/index.ts --step provider-auth codex
```

## OpenCode authentication

After installing `/add-opencode`, use the same provider-auth entry point:

```bash
pnpm exec tsx setup/index.ts --step provider-auth opencode
```

The OpenCode setup flow supports ChatGPT sign-in and API keys through Iron
Control. It installs no OneCLI service and needs no OneCLI management settings.
ChatGPT arrives as the seam's `chatgpt` OAuth profile: Iron creates a native
broker from OpenCode's public OAuth client and refresh token, and a separate
granted secret carries the `ChatGPT-Account-Id` header; any other OAuth profile
is rejected. The agent sees only placeholders. Initial sign-in and reauthentication wait for the
native broker to refresh successfully (up to two minutes) before setup continues. API keys use each backend's declared header
scheme. Setup grants the secrets to this install's principal and permits the
model hostname. Rotation and reauthentication keep IDs and grants. Moving a key
to another host requires confirmation and re-entering its value.

Native backends and custom/keyless HTTPS endpoints on port 443 are supported.
Use a DNS name and TLS for local models; plaintext HTTP endpoints fail during
setup. Follow the OpenCode skill to restart the host and test a real reply.

## Remove

Follow [REMOVE.md](REMOVE.md). Stop only this copy's proxy and console services. Keep the database volume and encryption keys together when preserving data.

### Provider credentials on shared model hosts

OpenCode and Codex use distinct non-secret markers. Iron replaces only the matching
header marker, so each runtime retains its own account on a shared HTTPS host.
Claude's managed model marker remains distinct. These replacements use
`require: false`: a request from another provider must pass without substitution.
The upstream API still rejects an unavailable or unmatched placeholder.

Refresh the installed provider payloads and rebuild the agent image before using
this version. Reconnect older Codex credentials to replace their host-wide injection
rules. If setup identifies a conflicting legacy or manual grant, reconnect that
provider with this version (including Claude's model credential), or remove the
conflicting grant in Iron Control. Stored secrets are write-only and are not
silently rewritten. Setup checks direct and role grants, including inactive OAuth
brokers. The installation's Iron principal remains the authorization boundary;
these markers select credentials, not permissions for separate untrusted tenants.
