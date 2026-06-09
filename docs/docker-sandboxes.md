# Running NanoClaw in Docker Sandboxes (Manual Setup)

> **Fast path:** All six sandbox-readiness patches from this guide have already been applied on the [`sandbox-ready` branch of `ealeyner/nanoclaw`](https://github.com/ealeyner/nanoclaw/tree/sandbox-ready). Clone that branch and skip Steps 4a–4f — `pnpm install`, `pnpm run build`, and `bash container/build.sh` are all you need.

This guide walks through setting up NanoClaw inside a [Docker Sandbox](https://docs.docker.com/ai/sandboxes/) from scratch — no install script, no pre-built fork. You'll clone the upstream repo, apply the necessary patches, and have agents running in full hypervisor-level isolation.

## Architecture

```
Host (macOS / Windows WSL)
└── Docker Sandbox (micro VM with isolated kernel)
    ├── NanoClaw process (Node.js)
    │   ├── Channel adapters (WhatsApp, Telegram, etc.)
    │   └── Container spawner → nested Docker daemon
    └── Docker-in-Docker
        └── nanoclaw-agent containers
            └── Claude Agent SDK
```

Each agent runs in its own container, inside a micro VM that is fully isolated from your host. Two layers of isolation: per-agent containers + the VM boundary.

The sandbox provides a MITM proxy at `host.docker.internal:3128` that handles network access and injects your Anthropic API key automatically.

> **Note:** This guide is based on a validated setup running on macOS (Apple Silicon) with WhatsApp. Other channels (Telegram, Slack, etc.) and environments (Windows WSL) may require additional proxy patches for their specific HTTP/WebSocket clients. The core patches (container runner, credential proxy, Dockerfile) apply universally — channel-specific proxy configuration varies.

## Prerequisites

- **Docker Desktop v4.40+** with Sandbox support
- **Anthropic API key** (the sandbox proxy manages injection)
- For **Telegram**: a bot token from [@BotFather](https://t.me/BotFather) and your chat ID
- For **WhatsApp**: a phone with WhatsApp installed

Verify sandbox support:
```bash
docker sandbox version
```

## Step 1: Create the Sandbox

On your host machine:

```bash
# Create a workspace directory
mkdir -p ~/nanoclaw-workspace

# Create a shell sandbox with the workspace mounted
docker sandbox create shell ~/nanoclaw-workspace
```

If you're using WhatsApp, configure proxy bypass so WhatsApp's Noise protocol isn't MITM-inspected:

```bash
docker sandbox network proxy shell-nanoclaw-workspace \
  --bypass-host web.whatsapp.com \
  --bypass-host "*.whatsapp.com" \
  --bypass-host "*.whatsapp.net"
```

Telegram does not need proxy bypass.

Enter the sandbox:
```bash
docker sandbox run shell-nanoclaw-workspace
```

## Step 2: Install Prerequisites

Inside the sandbox:

```bash
sudo apt-get update && sudo apt-get install -y build-essential python3
npm config set strict-ssl false
```

## Step 3: Clone and Install NanoClaw

NanoClaw must live inside the workspace directory — Docker-in-Docker can only bind-mount from the shared workspace path.

```bash
# Clone to home first (virtiofs can corrupt git pack files during clone)
cd ~
git clone https://github.com/nanocoai/nanoclaw.git

# Replace with YOUR workspace path (the host path you passed to `docker sandbox create`)
WORKSPACE=/Users/you/nanoclaw-workspace

# Move into workspace so DinD mounts work
mv nanoclaw "$WORKSPACE/nanoclaw"
cd "$WORKSPACE/nanoclaw"

# Install dependencies
pnpm install
pnpm install https-proxy-agent
```

## Step 4: Apply Proxy and Sandbox Patches

NanoClaw needs several patches to work inside a Docker Sandbox. These handle proxy routing, CA certificates, and Docker-in-Docker mount restrictions.

### 4a. Dockerfile — proxy args for container image build

`pnpm install` inside `docker build` fails with `SELF_SIGNED_CERT_IN_CHAIN` because the sandbox's MITM proxy presents its own certificate. Add proxy build args to `container/Dockerfile`:

Add these lines after the `FROM` line:

```dockerfile
# Accept proxy build args
ARG http_proxy
ARG https_proxy
ARG no_proxy
ARG NODE_EXTRA_CA_CERTS
ARG npm_config_strict_ssl=true
RUN npm config set strict-ssl ${npm_config_strict_ssl}
```

And after the `RUN pnpm install` line:

```dockerfile
RUN npm config set strict-ssl true
```

### 4b. Build script — forward proxy args

Patch `container/build.sh` to pass proxy env vars to `docker build`:

Add these `--build-arg` flags to the `docker build` command:

```bash
--build-arg http_proxy="${http_proxy:-$HTTP_PROXY}" \
--build-arg https_proxy="${https_proxy:-$HTTPS_PROXY}" \
--build-arg no_proxy="${no_proxy:-$NO_PROXY}" \
--build-arg npm_config_strict_ssl=false \
```

### 4c. Container runner — proxy forwarding, CA cert mount, /dev/null fix

Three changes to `src/container-runner.ts`:

**Replace `/dev/null` shadow mount.** The sandbox rejects `/dev/null` bind mounts. Find where `.env` is shadow-mounted to `/dev/null` and replace it with an empty file:

```typescript
// Create an empty file to shadow .env (Docker Sandbox rejects /dev/null mounts)
const emptyEnvPath = path.join(DATA_DIR, 'empty-env');
if (!fs.existsSync(emptyEnvPath)) fs.writeFileSync(emptyEnvPath, '');
// Use emptyEnvPath instead of '/dev/null' in the mount
```

**Forward proxy env vars** to spawned agent containers. Add `-e` flags for `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and their lowercase variants.

**Mount CA certificate.** If `NODE_EXTRA_CA_CERTS` or `SSL_CERT_FILE` is set, copy the cert into the project directory and mount it into agent containers:

```typescript
const caCertSrc = process.env.NODE_EXTRA_CA_CERTS || process.env.SSL_CERT_FILE;
if (caCertSrc) {
  const certDir = path.join(DATA_DIR, 'ca-cert');
  fs.mkdirSync(certDir, { recursive: true });
  fs.copyFileSync(caCertSrc, path.join(certDir, 'proxy-ca.crt'));
  // Mount: certDir -> /workspace/ca-cert (read-only)
  // Set NODE_EXTRA_CA_CERTS=/workspace/ca-cert/proxy-ca.crt in the container
}
```

### 4d. Container runtime — prevent self-termination

In `src/container-runtime.ts`, the `cleanupOrphans()` function matches containers by the `nanoclaw-` prefix. Inside a sandbox, the sandbox container itself may match (e.g., `nanoclaw-docker-sandbox`). Filter out the current hostname:

```typescript
// In cleanupOrphans(), filter out os.hostname() from the list of containers to stop
```

### 4e. Credential proxy — route through MITM proxy

In `src/credential-proxy.ts`, upstream API requests need to go through the sandbox proxy. Add `HttpsProxyAgent` to outbound requests:

```typescript
import { HttpsProxyAgent } from 'https-proxy-agent';

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
const upstreamAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
// Pass upstreamAgent to https.request() options
```

### 4f. Setup script — proxy build args

Patch `setup/container.ts` to pass the same proxy `--build-arg` flags as `build.sh` (Step 4b).

## Step 5: Build

```bash
pnpm run build
bash container/build.sh
```

## Step 6: Add a Channel

### Telegram

```bash
# Apply the Telegram skill
pnpm exec tsx scripts/apply-skill.ts .claude/skills/add-telegram

# Rebuild after applying the skill
pnpm run build

# Configure .env
cat > .env << EOF
TELEGRAM_BOT_TOKEN=<your-token-from-botfather>
ASSISTANT_NAME=nanoclaw
ANTHROPIC_API_KEY=proxy-managed
EOF
mkdir -p data/env && cp .env data/env/env

# Register your chat
pnpm exec tsx setup/index.ts --step register \
  --jid "tg:<your-chat-id>" \
  --name "My Chat" \
  --trigger "@nanoclaw" \
  --folder "telegram_main" \
  --channel telegram \
  --assistant-name "nanoclaw" \
  --is-main \
  --no-trigger-required
```

**To find your chat ID:** Send any message to your bot, then:
```bash
curl -s --proxy $HTTPS_PROXY "https://api.telegram.org/bot<TOKEN>/getUpdates" | python3 -m json.tool
```

**Telegram in groups:** Disable Group Privacy in @BotFather (`/mybots` > Bot Settings > Group Privacy > Turn off), then remove and re-add the bot.

**Important:** If the Telegram skill creates `src/channels/telegram.ts`, you'll need to patch it for proxy support. Add an `HttpsProxyAgent` and pass it to grammy's `Bot` constructor via `baseFetchConfig.agent`. Then rebuild.

### WhatsApp

Make sure you configured proxy bypass in [Step 1](#step-1-create-the-sandbox) first.

```bash
# Apply the WhatsApp skill
pnpm exec tsx scripts/apply-skill.ts .claude/skills/add-whatsapp

# Rebuild
pnpm run build

# Configure .env
cat > .env << EOF
ASSISTANT_NAME=nanoclaw
ANTHROPIC_API_KEY=proxy-managed
EOF
mkdir -p data/env && cp .env data/env/env

# Authenticate (choose one):

# QR code — scan with WhatsApp camera:
pnpm exec tsx src/whatsapp-auth.ts

# OR pairing code — enter code in WhatsApp > Linked Devices > Link with phone number:
pnpm exec tsx src/whatsapp-auth.ts --pairing-code --phone <phone-number-no-plus>

# Register your chat (JID = your phone number + @s.whatsapp.net)
pnpm exec tsx setup/index.ts --step register \
  --jid "<phone>@s.whatsapp.net" \
  --name "My Chat" \
  --trigger "@nanoclaw" \
  --folder "whatsapp_main" \
  --channel whatsapp \
  --assistant-name "nanoclaw" \
  --is-main \
  --no-trigger-required
```

**Important:** The WhatsApp skill files (`src/channels/whatsapp.ts` and `src/whatsapp-auth.ts`) also need proxy patches — add `HttpsProxyAgent` for WebSocket connections and a proxy-aware version fetch. Then rebuild.

### Both Channels

Apply both skills, patch both for proxy support, combine the `.env` variables, and register each chat separately.

## Step 7: Run

```bash
pnpm start
```

You don't need to set `ANTHROPIC_API_KEY` manually. The sandbox proxy intercepts requests and replaces `proxy-managed` with your real key automatically.

## Networking Details

### How the proxy works

All traffic from the sandbox routes through the host proxy at `host.docker.internal:3128`:

```
Agent container → DinD bridge → Sandbox VM → host.docker.internal:3128 → Host proxy → api.anthropic.com
```

**"Bypass" does not mean traffic skips the proxy.** It means the proxy passes traffic through without MITM inspection. Node.js doesn't automatically use `HTTP_PROXY` env vars — you need explicit `HttpsProxyAgent` configuration in every HTTP/WebSocket client.

### Shared paths for DinD mounts

Only the workspace directory is available for Docker-in-Docker bind mounts. Paths outside the workspace fail with "path not shared":
- `/dev/null` → replace with an empty file in the project dir
- `/usr/local/share/ca-certificates/` → copy cert to project dir
- `/home/agent/` → clone to workspace instead

### Git clone and virtiofs

The workspace is mounted via virtiofs. Git's pack file handling can corrupt over virtiofs during clone. Workaround: clone to `/home/agent` first, then `mv` into the workspace.

## Troubleshooting

### pnpm install fails with SELF_SIGNED_CERT_IN_CHAIN
```bash
npm config set strict-ssl false
```

### Container build fails with proxy errors
```bash
docker build \
  --build-arg http_proxy=$http_proxy \
  --build-arg https_proxy=$https_proxy \
  -t nanoclaw-agent:latest container/
```

### Agent containers fail with "path not shared"
All bind-mounted paths must be under the workspace directory. Check:
- Is NanoClaw cloned into the workspace? (not `/home/agent/`)
- Is the CA cert copied to the project root?
- Has the empty `.env` shadow file been created?

### Agent containers can't reach Anthropic API
Verify proxy env vars are forwarded to agent containers. Check container logs for `HTTP_PROXY=http://host.docker.internal:3128`.

### WhatsApp error 405
The version fetch is returning a stale version. Make sure the proxy-aware `fetchWaVersionViaProxy` patch is applied — it fetches `sw.js` through `HttpsProxyAgent` and parses `client_revision`.

### WhatsApp "Connection failed" immediately
Proxy bypass not configured. From the **host**, run:
```bash
docker sandbox network proxy <sandbox-name> \
  --bypass-host web.whatsapp.com \
  --bypass-host "*.whatsapp.com" \
  --bypass-host "*.whatsapp.net"
```

### Telegram bot doesn't receive messages
1. Check the grammy proxy patch is applied (look for `HttpsProxyAgent` in `src/channels/telegram.ts`)
2. Check Group Privacy is disabled in @BotFather if using in groups

### Git clone fails with "inflate: data stream error"
Clone to a non-workspace path first, then move:
```bash
cd ~ && git clone https://github.com/nanocoai/nanoclaw.git && mv nanoclaw /path/to/workspace/nanoclaw
```

### WhatsApp QR code doesn't display
Run the auth command interactively inside the sandbox (not piped through `docker sandbox exec`):
```bash
docker sandbox run shell-nanoclaw-workspace
# Then inside:
pnpm exec tsx src/whatsapp-auth.ts
```
