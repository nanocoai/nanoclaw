#!/usr/bin/env bash
# Restart this checkout and require a response from a new host instance.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
# Always derive labels from this script's checkout, even when called elsewhere.
export NANOCLAW_PROJECT_ROOT="$root"
source "$here/install-slug.sh"

channel_args=()
if [ "$#" -gt 0 ]; then
  if [ "$#" -ne 2 ] || [ "$1" != "--channel" ] || [ -z "$2" ]; then
    echo "Usage: restart.sh [--channel <adapter-instance>]" >&2
    exit 64
  fi
  channel_args=(--channel "$2")
fi
previous="$(node "$here/host-status.mjs" snapshot "$root" 2>/dev/null || true)"

restart_darwin() {
  local label domain plist
  label="$(launchd_label)"
  domain="gui/$(id -u)"
  plist="$HOME/Library/LaunchAgents/${label}.plist"
  if launchctl print "$domain/$label" >/dev/null 2>&1; then
    launchctl kickstart -k "$domain/$label"
  elif [ -f "$plist" ]; then
    launchctl bootstrap "$domain" "$plist"
    launchctl kickstart "$domain/$label"
  else
    echo "NanoClaw service is not installed. Run the setup service step first." >&2
    return 1
  fi
}

case "$(uname -s)" in
  Darwin) restart_darwin ;;
  Linux)
    unit="$(systemd_unit)"
    if systemctl --user cat "$unit" >/dev/null 2>&1; then
      systemctl --user restart "$unit"
    elif systemctl cat "$unit" >/dev/null 2>&1; then
      if [ "$(id -u)" = 0 ]; then systemctl restart "$unit"; else sudo -n systemctl restart "$unit"; fi
    elif [ -f "$root/start-nanoclaw.sh" ]; then
      /bin/bash "$root/start-nanoclaw.sh"
    else
      echo "NanoClaw service is not installed. Run the setup service step first." >&2
      exit 1
    fi
    ;;
  *) echo "Unsupported service platform" >&2; exit 1 ;;
esac

node "$here/host-status.mjs" wait "$root" --previous "$previous" "${channel_args[@]}"
