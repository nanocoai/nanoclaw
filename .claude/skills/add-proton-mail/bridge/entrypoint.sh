#!/bin/bash
# Three modes:
#   init            — one-time interactive login (`login`, then `exit`). Creates
#                     the pass keyring on first use.
#   secrets <field> — print one field from the vault for setup (see
#                     bridge-secrets.sh); the vault itself never leaves here.
#   (none)          — run the bridge headless, forever.
set -euo pipefail

# This image is Bridge built from source for the host's architecture. Proton's
# updater only ever downloads its own x86 binary, which the launcher then
# prefers and fails to exec ("exec format error") on arm64 — and on x86 it would
# replace the pinned build with one this image never checked. Auto-update is
# also switched off in the vault (`updates autoupdates disable`); this is the
# backstop. Upgrades are manual: bump BRIDGE_VERSION/BRIDGE_COMMIT and rebuild.
updates="${HOME:?}/.local/share/protonmail/bridge-v3/updates"
if [[ -d "$updates" ]] && [[ -n "$(ls -A "$updates")" ]]; then
  echo "entrypoint: discarding downloaded Bridge updates: $(ls "$updates" | tr '\n' ' ')"
  rm -rf "${updates:?}"/*
fi

if [[ "${1:-}" == "secrets" ]]; then
  shift
  exec bash /protonmail/bridge-secrets.sh "$@"
fi

if [[ "${1:-}" == "init" ]]; then
  shift
  if ! pass ls >/dev/null 2>&1; then
    gpg --batch --generate-key /protonmail/gpgparams
    pass init nanoclaw-bridge
  fi
  # Only one bridge may run against the vault at a time.
  pkill -x bridge 2>/dev/null || true
  exec /protonmail/bridge --cli "$@"
fi

# Bridge binds 127.0.0.1:1025/1143 only. socat re-exposes them on the container
# interface under DIFFERENT ports (2025/2143): same-port forwarding would
# connect socat to itself until the bridge is up — a fork storm. The container
# runs on a network of its own (nanoclaw-mail), so only the host reaches these,
# through -p 127.0.0.1:1025:2025 -p 127.0.0.1:1143:2143.
socat TCP-LISTEN:2025,fork,reuseaddr TCP:127.0.0.1:1025 &
socat TCP-LISTEN:2143,fork,reuseaddr TCP:127.0.0.1:1143 &
exec /protonmail/bridge --noninteractive "$@"
