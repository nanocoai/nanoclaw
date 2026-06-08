#!/usr/bin/env bash
# Print the current Cloudflare quick-tunnel URL for the G2 bridge.
# Quick-tunnel URLs rotate whenever the cloudflared service restarts.
grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$(dirname "$0")/../logs/cloudflared.log" | tail -1
