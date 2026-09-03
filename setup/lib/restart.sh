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

case "$(uname -s)" in
  Darwin) launchctl kickstart -k "gui/$(id -u)/$(launchd_label)" 2>/dev/null || true ;;
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
