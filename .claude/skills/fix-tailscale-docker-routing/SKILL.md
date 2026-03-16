---
name: fix-tailscale-docker-routing
description: Fix Docker container networking when Tailscale exit node (e.g. Mullvad) is active. Containers can't reach the internet because Tailscale's catch-all routing rule intercepts return packets destined for the Docker bridge subnet. Installs a persistent ip rule and systemd service to fix this. Triggers on "docker containers can't connect", "exit node breaks docker", "tailscale mullvad docker", "containers no internet with tailscale".
---

# Fix Tailscale Exit Node + Docker Routing

When a Tailscale exit node is active, Tailscale inserts an ip rule (`5270: from all lookup 52`) that routes all traffic — including return packets to Docker containers — through `tailscale0`. Since the Mullvad exit node has no knowledge of `172.16.0.0/12` (Docker's private bridge range), those packets are dropped. The fix is a higher-priority rule that routes Docker-destined packets via the main table before Tailscale intercepts them.

This only affects Linux hosts using a Tailscale exit node. macOS uses a different networking stack and is unaffected.

## Phase 1: Pre-flight

### Check platform

```bash
uname -s
```

If not `Linux`, tell the user this fix is Linux-only and exit.

### Check Tailscale is installed and exit node is active

```bash
tailscale status --json 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
exit_id = d.get('ExitNodeStatus', {}).get('ID', '')
prefs_exit = ''
# also check via prefs
print('exit_node_active:', bool(exit_id))
"
```

Also check prefs directly:

```bash
tailscale debug prefs 2>/dev/null | grep -i ExitNode
```

If no exit node is configured, tell the user this fix only applies when using a Tailscale exit node.

### Check if Docker is installed

```bash
docker info &>/dev/null && echo "docker_ok" || echo "docker_missing"
```

If Docker is missing, exit — nothing to fix.

### Check if the routing issue is present

```bash
ip rule show | grep "5270"
ip route show table 52 | grep -E "^default|172.16"
```

If rule 5270 exists and table 52 has a `default dev tailscale0` entry, the issue is present.

### Check if the fix is already applied

```bash
ip rule show | grep "5269.*172.16.0.0/12"
```

If the rule already exists and the systemd service is active:

```bash
systemctl is-active docker-tailscale-routing-patch.service 2>/dev/null
```

If both are present, skip to Phase 3 (Verify).

## Phase 2: Apply Fix

### Add the ip rule immediately

This takes effect without a reboot:

```bash
sudo ip rule add to 172.16.0.0/12 lookup main priority 5269
```

Verify it was added:

```bash
ip rule show | grep 5269
```

Expected: `5269: from all to 172.16.0.0/12 lookup main`

### Install the systemd service for persistence

The rule is lost on reboot without a service to restore it. Create the service file:

```bash
sudo tee /etc/systemd/system/docker-tailscale-routing-patch.service > /dev/null << 'EOF'
[Unit]
Description=Fix Docker bridge routing when Tailscale exit node is active
After=network.target tailscaled.service docker.service
Wants=tailscaled.service docker.service

[Service]
Type=oneshot
ExecStart=/bin/sh -c '/sbin/ip rule show | grep -q "5269.*172.16.0.0/12" || /sbin/ip rule add to 172.16.0.0/12 lookup main priority 5269'
ExecStop=/sbin/ip rule del to 172.16.0.0/12 lookup main priority 5269
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
```

Enable and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now docker-tailscale-routing-patch.service
```

Verify:

```bash
systemctl is-active docker-tailscale-routing-patch.service
```

Expected: `active`

## Phase 3: Verify

### Test container connectivity

```bash
docker run --rm alpine sh -c "nslookup api.anthropic.com && wget -qO- --timeout=5 https://api.anthropic.com 2>&1 | head -2"
```

Expected:
- DNS resolves `api.anthropic.com` to an IP
- `wget` gets `HTTP/1.1 404` (correct — no API key, but TCP connected successfully)

If DNS fails (`EAI_AGAIN`) or TCP times out (`ETIMEDOUT`), the fix did not take effect — check that the rule is present with `ip rule show | grep 5269`.

### Restart NanoClaw

```bash
systemctl --user restart nanoclaw
```

Then send a test message from WhatsApp.

## How it works

Tailscale's exit node inserts `5270: from all lookup 52` which makes table 52 the catch-all for all outgoing packets. Table 52 contains `default dev tailscale0`, so return packets destined for `172.17.0.2` (a container) get sent to Tailscale rather than back to `docker0`. Tailscale drops them because the Mullvad exit node doesn't know about Docker's private subnet.

The fix adds `5269: from all to 172.16.0.0/12 lookup main` — checked one step before Tailscale's rule — which routes packets destined for any Docker bridge address via the main routing table, where `172.16.0.0/12 dev docker0` correctly delivers them locally.

Internet-bound traffic from containers (source-NATed to the host's Tailscale IP by Docker's MASQUERADE rule) is unaffected — its destination is never in `172.16.0.0/12`, so it continues to flow through Tailscale and out via Mullvad as intended.

## Troubleshooting

### Service fails to start

The rule may already exist from a previous manual run. The `ExecStart` command is idempotent — it checks before adding. If the service still fails:

```bash
journalctl -u docker-tailscale-routing-patch.service --no-pager
```

### Rule disappears after Tailscale restarts

Tailscale may flush and re-add its routing rules on reconnect. If this happens, the service ordering (`After=tailscaled.service`) should handle it — but if Tailscale restarts mid-session you may need to manually re-run:

```bash
sudo ip rule add to 172.16.0.0/12 lookup main priority 5269
```

Consider filing an issue with Tailscale — this is a known conflict tracked at https://github.com/tailscale/tailscale/issues/13367.

### Still broken after applying fix

Check that Tailscale is actually using an exit node (not just installed):

```bash
tailscale status | grep "exit node"
```

If no exit node is shown, this fix is not the right one for your issue — use `/debug` to investigate further.
