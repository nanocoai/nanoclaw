#!/bin/bash
# Two modes:
#   init   — one-time interactive login: run `login`, then `info` to read the
#            bridge's local IMAP/SMTP password. Creates the pass keyring on
#            first use.
#   (none) — run the bridge headless, forever.
set -euo pipefail

if [[ "${1:-}" == "init" ]]; then
  shift
  if ! pass ls >/dev/null 2>&1; then
    gpg --batch --generate-key /protonmail/gpgparams
    pass init nanoclaw-bridge
  fi
  # Only one bridge may run against the vault at a time.
  pkill -x bridge 2>/dev/null || true
  exec /protonmail/proton-bridge --cli "$@"
fi

# Bridge binds 127.0.0.1:1025/1143 only. socat re-exposes them on the container
# interface under DIFFERENT ports (2025/2143): same-port forwarding would
# connect socat to itself until the bridge is up — a fork storm. Publish
# with -p 127.0.0.1:1025:2025 -p 127.0.0.1:1143:2143.
socat TCP-LISTEN:2025,fork,reuseaddr TCP:127.0.0.1:1025 &
socat TCP-LISTEN:2143,fork,reuseaddr TCP:127.0.0.1:1143 &
exec /protonmail/proton-bridge --noninteractive "$@"
