#!/usr/bin/env bash
# Restart the NanoClaw service, then wait (best-effort) for its `ncl` CLI socket
# so a following wiring directive doesn't race the restart. Channel skills call
# this as `nc:run effect:restart`. Best-effort throughout: a fresh setup may not
# have the service installed yet, and the wiring's own `ncl` call is the real
# signal if the socket never appears — so a wait timeout does not fail the step.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
# shellcheck source=/dev/null
source "$here/install-slug.sh"

# macOS: `launchctl kickstart` only operates on services that are currently
# LOADED. If the plist was unloaded (by the user, or by peer cleanup), a bare
# kickstart returns non-zero, the `|| true` swallows it, and this script
# reports a restart that never happened — the host stays down and the next
# wiring step fails on a dead CLI socket (#2583). Probe the loaded state
# first and bootstrap the plist when it isn't.
restart_darwin() {
  local label domain plist
  label="$(launchd_label)"
  domain="gui/$(id -u)"
  plist="$HOME/Library/LaunchAgents/${label}.plist"

  if launchctl print "$domain/$label" >/dev/null 2>&1; then
    launchctl kickstart -k "$domain/$label" 2>/dev/null || true
  elif [ -f "$plist" ]; then
    # Not loaded but installed — load it (bootstrap starts RunAtLoad jobs;
    # kickstart demand-starts in case launchd leaves the job pended).
    launchctl bootstrap "$domain" "$plist" 2>/dev/null || true
    launchctl kickstart "$domain/$label" 2>/dev/null || true
  fi
  # Neither loaded nor installed: fresh setup before the service step —
  # nothing to restart, and the socket wait below stays a fast no-op signal.
}

case "$(uname -s)" in
  Darwin) restart_darwin ;;
  Linux) systemctl --user restart "$(systemd_unit)" 2>/dev/null \
    || sudo systemctl restart "$(systemd_unit)" 2>/dev/null || true ;;
esac

# Wait up to ~30s for the CLI socket so `ncl` can connect on the next directive.
for _ in $(seq 1 60); do
  [ -S "$root/data/ncl.sock" ] && exit 0
  sleep 0.5
done
echo "nanoclaw: ncl socket not up yet after restart — the wiring step may need a retry" >&2
exit 0
