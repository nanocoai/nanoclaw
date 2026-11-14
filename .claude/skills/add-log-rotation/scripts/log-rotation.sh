#!/usr/bin/env bash
# Host log rotation for one NanoClaw install (Linux + systemd).
#
#   log-rotation.sh install    # write config + timer for this install, enable it
#   log-rotation.sh uninstall  # disable the timer, delete everything install wrote
#   log-rotation.sh status     # show the timer and the last run
#   log-rotation.sh render-conf | render-service | render-timer   # print, write nothing
#
# Run from the NanoClaw project root, or set NANOCLAW_PROJECT_ROOT.
# Everything is named after the install's service unit (setup/lib/install-slug.sh),
# so several copies on one machine each get their own timer.
set -euo pipefail

cmd="${1:-}"
root="${NANOCLAW_PROJECT_ROOT:-$PWD}"
root="$(cd "$root" && pwd -P)"

die() { echo "log-rotation: $*" >&2; exit 1; }

[ -f "$root/setup/lib/install-slug.sh" ] || die "$root is not a NanoClaw project root (no setup/lib/install-slug.sh)"
case "$root" in
  *[\"\\$'\n']*) die "project path contains a quote, backslash or newline; rename it first" ;;
esac

# shellcheck source=/dev/null
PROJECT_ROOT="$root" source "$root/setup/lib/install-slug.sh"
unit="$(PROJECT_ROOT="$root" NANOCLAW_PROJECT_ROOT="$root" systemd_unit)-logrotate"

# Root installs run NanoClaw as a system service, so the timer is a system unit too.
if [ "$(id -u)" -eq 0 ]; then
  sc() { systemctl "$@"; }
  manager="system"
  unit_dir="/etc/systemd/system"
else
  sc() { systemctl --user "$@"; }
  manager="user"
  unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
fi
conf_dir="${XDG_CONFIG_HOME:-$HOME/.config}/nanoclaw"
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/nanoclaw"
conf="$conf_dir/$unit.conf"
state="$state_dir/$unit.status"

logrotate_bin() {
  command -v logrotate 2>/dev/null || { [ -x /usr/sbin/logrotate ] && echo /usr/sbin/logrotate; } || true
}

# systemd expands % specifiers in ExecStart; double them so a path is taken literally.
sd_escape() { printf '%s' "${1//%/%%}"; }

render_conf() {
  cat <<EOF
# NanoClaw host log rotation for $root
# Written by /add-log-rotation; run hourly by $unit.timer.
#
# copytruncate is safe here: the service opens both files in append mode
# (systemd StandardOutput=append:, launchd and nohup likewise), so after the
# truncate the writer continues at the new end of file. No restart, no signal.
"$root/logs/nanoclaw.log" "$root/logs/nanoclaw.error.log" {
    daily
    maxsize 50M
    rotate 14
    missingok
    notifempty
    copytruncate
    compress
    dateext
    dateformat -%Y%m%d-%H%M%S
}
EOF
}

render_service() {
  local bin
  bin="$(logrotate_bin)"
  cat <<EOF
[Unit]
Description=Rotate NanoClaw host logs ($root/logs)

[Service]
Type=oneshot
Nice=19
IOSchedulingClass=idle
ExecStart=${bin:-/usr/sbin/logrotate} --state "$(sd_escape "$state")" "$(sd_escape "$conf")"
EOF
}

render_timer() {
  cat <<EOF
[Unit]
Description=Hourly check for NanoClaw host log rotation ($root/logs)

[Timer]
OnCalendar=hourly
RandomizedDelaySec=5m
Persistent=true

[Install]
WantedBy=timers.target
EOF
}

require_systemd() {
  command -v systemctl >/dev/null 2>&1 || die "systemd is required (this machine has no systemctl)"
  sc show-environment >/dev/null 2>&1 \
    || die "no systemd $manager manager is reachable from this shell"
}

case "$cmd" in
  render-conf) render_conf ;;
  render-service) render_service ;;
  render-timer) render_timer ;;
  install)
    require_systemd
    [ -n "$(logrotate_bin)" ] || die "logrotate is not installed (apt install logrotate, or dnf install logrotate)"
    service="$(render_service)"
    mkdir -p "$unit_dir" "$conf_dir" "$state_dir"
    tmp="$(mktemp "$conf_dir/.$unit.XXXXXX")"
    render_conf >"$tmp"
    chmod 0644 "$tmp"
    # Dry run against the real files first; keep the old config if this one is bad.
    if ! out="$("$(logrotate_bin)" --debug --state "$state" "$tmp" 2>&1)"; then
      rm -f "$tmp"
      echo "$out" >&2
      die "logrotate rejected the generated config; nothing was changed"
    fi
    mv -f "$tmp" "$conf"
    printf '%s\n' "$service" >"$unit_dir/$unit.service"
    render_timer >"$unit_dir/$unit.timer"
    chmod 0644 "$unit_dir/$unit.service" "$unit_dir/$unit.timer"
    sc daemon-reload
    sc enable --now "$unit.timer"
    sc list-timers "$unit.timer" --no-pager
    ;;
  uninstall)
    require_systemd
    sc disable --now "$unit.timer" 2>/dev/null || true
    rm -f "$unit_dir/$unit.service" "$unit_dir/$unit.timer" "$conf" "$state"
    rmdir "$conf_dir" "$state_dir" 2>/dev/null || true
    sc daemon-reload
    echo "Removed $unit (timer, service, config, state). Rotated archives in $root/logs were left in place."
    ;;
  status)
    require_systemd
    sc list-timers "$unit.timer" --no-pager
    sc status "$unit.service" --no-pager --lines 5 || true
    ;;
  *)
    sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
    [ -z "$cmd" ] || exit 2
    ;;
esac
