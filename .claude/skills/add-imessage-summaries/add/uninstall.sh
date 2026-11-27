#!/bin/bash
# Removes the iMessage reader. Run as: sudo ./uninstall.sh
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run with sudo: sudo $0" >&2; exit 1; }
USER_NAME="${SUDO_USER:?Run this with sudo from your own account}"
USER_ID="$(id -u "$USER_NAME")"
USER_HOME="$(dscl . -read "/Users/$USER_NAME" NFSHomeDirectory | awk '{print $2}')"

launchctl bootout "gui/$USER_ID/com.nanoclaw.imsg-reader" 2>/dev/null || true
rm -f /Library/LaunchAgents/com.nanoclaw.imsg-reader.plist
rm -f /usr/local/libexec/imsg-reader /usr/local/libexec/imsg-reader-config
rm -rf "/Library/Application Support/imsg-reader"
rmdir /usr/local/libexec 2>/dev/null || true

cat <<EOF
Removed the reader, its config and its job.
- Remove imsg-reader from System Settings > Privacy & Security > Full Disk Access.
- Summaries already written stay in "$USER_HOME/Library/Application Support/imsg-reader".
  Delete them with: rm -rf "$USER_HOME/Library/Application Support/imsg-reader"
EOF
