---
name: add-agent-network
description: Add per-agent outbound internet access policy via a Squid HTTP proxy. Each agent attaches to an --internal Docker network; outbound traffic egresses through Squid → OneCLI; per-agent ACLs enforced from `agent_groups.internet_access_policy`. Installs the SquidNetworkPolicyProvider implementation and the /manage-agent-network operator skill.
---

# Add Agent Network

NanoClaw's core ships a `NetworkPolicyProvider` extension point but no provider — by default, agents have unrestricted outbound. This skill installs the **Squid-based provider** and the `/manage-agent-network` operator skill that drives it.

## What you get

- A `nanoclaw-egress` Docker network (`--internal`, no NAT).
- A `nanoclaw-squid` container, dual-homed, that tunnels every CONNECT through OneCLI (OneCLI remains the only MITM).
- A `socat` sidecar in the Squid container for raw-TCP CDP forwarding (Playwright / `ws://` bypasses `HTTPS_PROXY`).
- Per-agent WAN buckets: `full` / `whitelisted` / `model-only`. The agent's declared provider's API hosts are always allowed.
- A `/manage-agent-network` operator skill for ongoing per-agent edits (WAN policy + LAN edges in `agent_destinations`).

## Pre-flight (idempotent)

Skip to **Bootstrap and verify** if all of these are already in place:

- `src/modules/network/squid-policy-provider.ts` exists
- `src/modules/network/index.ts` contains `import './squid-policy-provider.js';`
- `data/squid/host-secret` exists
- `docker images -q nanoclaw-squid` returns a non-empty image id

Otherwise continue. The merge is idempotent — re-running the steps below is safe.

### 1. Fetch and merge the skill branch

```bash
git fetch upstream skill/agent-network
git merge upstream/skill/agent-network
```

The merge brings in the provider implementation (`src/modules/network/squid-policy-provider.ts`), the per-provider host registry (`src/providers/provider-hosts-registry.ts`), the Squid container image sources (`container/squid/*`), the operator skill (`.claude/skills/manage-agent-network/*`), and appends the provider's self-registration import to `src/modules/network/index.ts`.

If `upstream` doesn't exist as a remote: `git remote add upstream https://github.com/qwibitai/nanoclaw.git` first.

### 2. Generate the host secret

The per-agent Squid auth tokens are `HMAC(host-secret, agent_group_id)` — no token state to persist. The secret is local-only and never leaves disk.

```bash
mkdir -p data/squid
test -f data/squid/host-secret \
  || node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" \
       > data/squid/host-secret
chmod 600 data/squid/host-secret
```

### 3. Build the Squid container image

```bash
./container/squid/build.sh
```

### 4. Build the host

```bash
pnpm run build
```

## Bootstrap and verify

The Docker network and the running Squid container are created lazily by `NetworkPolicyProvider.ensure()` on host startup. Bounce so it fires:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw      # macOS
# systemctl --user restart nanoclaw                    # Linux
```

Verify:

```bash
docker network ls | grep nanoclaw-egress
docker ps         | grep nanoclaw-squid
grep -F 'Network policy provider attached' logs/nanoclaw.log | tail -3
```

By default every agent stays effectively `full` (unrestricted) until you set a policy. Existing agent sessions keep working — Squid in the path is invisible to working traffic.

## Configure the first agent

For one-off edits, call `configure.ts` directly:

```bash
# Restrict to provider hosts only (e.g. api.anthropic.com for a claude agent)
pnpm exec tsx .claude/skills/manage-agent-network/scripts/configure.ts \
  --agent <agent-folder> --wan model-only

# Whitelist a few domains in addition to provider hosts
pnpm exec tsx .claude/skills/manage-agent-network/scripts/configure.ts \
  --agent <agent-folder> --wan whitelisted \
  --domains nytimes.com,reuters.com

# Inspect current state for an agent
pnpm exec tsx .claude/skills/manage-agent-network/scripts/configure.ts --show <agent-folder>
```

For an interactive walkthrough (per-agent review, edits, LAN-edge CRUD), invoke `/manage-agent-network`.

## Uninstall

```bash
pnpm exec tsx .claude/skills/manage-agent-network/scripts/uninstall.ts
```

Stops and removes the Squid container, removes the Docker network, and clears the running policy. To fully revert the file changes brought in by the merge, find the merge commit and revert it:

```bash
git log --merges --oneline | grep agent-network
git revert -m 1 <merge-commit>
```

`data/squid/host-secret` is preserved so a future re-install keeps deterministic per-agent tokens.

## Troubleshooting

**`docker: Error response from daemon: network nanoclaw-egress not found` on agent spawn.** Provider's `ensure()` hasn't run, usually because the host didn't bounce after install. Restart the host.

**Agent gets `403 Forbidden` from a domain that should be allowed.** Run `/manage-agent-network` and check the agent's bucket and domain list, or `docker exec nanoclaw-squid cat /etc/squid/squid.conf` to inspect the generated rules.

**Agent gets `407 Proxy Authentication Required`.** The per-agent token in `/etc/squid/agent-tokens` is out of sync with what the container sees. Re-run any `configure.ts` command (every edit regenerates the tokens file and reloads Squid), or `data/squid/host-secret` was rotated mid-flight — re-bounce affected agents.

**Squid container restarts in a loop.** `docker logs nanoclaw-squid` — usually a config-parse error in `/etc/squid/squid.conf` from a malformed `internet_access_policy` JSON blob. Inspect with `pnpm exec tsx scripts/q.ts data/v2.db "SELECT id, name, internet_access_policy FROM agent_groups WHERE internet_access_policy IS NOT NULL"`.
