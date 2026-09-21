#!/usr/bin/env bash
# Restart this checkout and require a response from a new host instance.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
# Always derive labels from this script's checkout, even when called elsewhere.
export NANOCLAW_PROJECT_ROOT="$root"
# shellcheck source=/dev/null
source "$here/install-slug.sh"

channel=""
if [ "$#" -gt 0 ]; then
  if [ "$#" -ne 2 ] || [ "$1" != "--channel" ] || [ -z "$2" ]; then
    echo "Usage: restart.sh [--channel <adapter-instance>]" >&2
    exit 64
  fi
  channel="$2"
fi
previous="$(node "$here/host-status.mjs" snapshot "$root" 2>/dev/null || true)"
# A snapshot can fail on an old host without the status command or an
# unresponsive socket. Still require a process born after this request.
started_after="$(node -e 'console.log(Date.now())')"
pid=""

restart_darwin() {
  local label domain plist
  label="$(launchd_label)"
  domain="gui/$(id -u)"
  plist="$HOME/Library/LaunchAgents/${label}.plist"

  if launchctl print "$domain/$label" >/dev/null 2>&1; then
    pid="$(launchctl kickstart -k -p "$domain/$label")" || return $?
  elif [ -f "$plist" ]; then
    # `kickstart` cannot load an installed-but-unloaded job. Bootstrap the
    # plist first, then demand-start it in case RunAtLoad remains pended.
    launchctl bootstrap "$domain" "$plist" || return $?
    pid="$(launchctl kickstart -p "$domain/$label")" || return $?
  else
    echo "NanoClaw service is not installed. Run the setup service step first." >&2
    return 2
  fi
}

restarted=false
case "$(uname -s)" in
  Darwin)
    # An installed job's failure must propagate, even if a fallback exists.
    restart_darwin
    restarted=true
    ;;
  Linux)
    unit="$(systemd_unit)"
    if systemctl --user cat "$unit" >/dev/null 2>&1; then
      systemctl --user restart "$unit"
      pid="$(systemctl --user show "$unit" --property=MainPID --value)"
      restarted=true
    elif systemctl cat "$unit" >/dev/null 2>&1; then
      if [ "$(id -u)" = 0 ]; then systemctl restart "$unit"; else sudo -n systemctl restart "$unit"; fi
      pid="$(systemctl show "$unit" --property=MainPID --value)"
      restarted=true
    fi
    ;;
esac

# Linux installs without a usable systemd user bus run through the generated
# nohup wrapper. Restart that exact checkout when no service manager accepted
# the request; otherwise channel installs would leave the old host running.
if [ "$restarted" = false ] && [ -x "$root/start-nanoclaw.sh" ]; then
  if "$root/start-nanoclaw.sh"; then
    restarted=true
    pid="$(cat "$root/nanoclaw.pid")"
  else
    echo "nanoclaw: nohup fallback restart failed" >&2
    exit 1
  fi
fi

if [ "$restarted" = false ]; then
  echo "nanoclaw: no installed service or nohup launcher to restart" >&2
  exit 1
fi

args=(wait "$root" --previous "$previous" --pid "$pid" --started-after "$started_after")
if [ -n "$channel" ]; then args+=(--channel "$channel"); fi
node "$here/host-status.mjs" "${args[@]}"
