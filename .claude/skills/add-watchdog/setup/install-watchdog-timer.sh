#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"

mkdir -p "$SYSTEMD_USER_DIR"

cp "$SCRIPT_DIR/watchdog.service" "$SYSTEMD_USER_DIR/nanoclaw-watchdog.service"
cp "$SCRIPT_DIR/watchdog.timer"   "$SYSTEMD_USER_DIR/nanoclaw-watchdog.timer"

systemctl --user daemon-reload
systemctl --user enable --now nanoclaw-watchdog.timer

echo "NanoClaw watchdog timer installed and started."
systemctl --user status nanoclaw-watchdog.timer --no-pager
