#!/bin/bash
# Installs the iMessage reader. Run from the NanoClaw project root, after build.sh:
#   sudo .claude/skills/add-imessage-summaries/add/install.sh
# Everything installed is owned by root, so nothing running as you can change what it reads.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
[[ $EUID -eq 0 ]] || { echo "Run with sudo: sudo $0" >&2; exit 1; }
USER_NAME="${SUDO_USER:?Run this with sudo from your own account}"
USER_ID="$(id -u "$USER_NAME")"
APP="/Library/Application Support/imsg-reader"
BIN=/usr/local/libexec
BUILD="${BUILD_DIR:-$PWD/dist/imsg-reader}/release"

for b in imsg-reader imsg-reader-config; do
  [[ -x "$BUILD/$b" ]] || { echo "Missing $BUILD/$b. Run build.sh first, without sudo, from the project root." >&2; exit 1; }
  # Capture first: piping into grep -q can kill codesign mid-output, and pipefail then reads that as a failure.
  sig="$(codesign -dv "$BUILD/$b" 2>&1)" || true
  [[ "$sig" == *"flags="*"runtime"* ]] || { echo "$b isn't signed with the hardened runtime. Run build.sh again." >&2; exit 1; }
done

echo "About to install these builds:"
shasum -a 256 "$BUILD/imsg-reader" "$BUILD/imsg-reader-config" | sed "s#$BUILD/##"
read -r -p "Do these match the hashes build.sh printed? [y/N] " ok
[[ "$ok" == "y" || "$ok" == "Y" ]] || { echo "Stopped. Nothing installed."; exit 1; }

install -d -o root -g wheel -m 755 "$BIN" "$APP"
install -o root -g wheel -m 755 "$BUILD/imsg-reader" "$BIN/imsg-reader"
install -o root -g wheel -m 755 "$BUILD/imsg-reader-config" "$BIN/imsg-reader-config"
codesign --verify --strict "$BIN/imsg-reader" "$BIN/imsg-reader-config"

# A new config allows nothing: no threads, setup on so the next run lists chats to pick from.
SUDO_USER="$USER_NAME" "$BIN/imsg-reader-config" init

install -o root -g wheel -m 644 "$HERE/com.nanoclaw.imsg-reader.plist" /Library/LaunchAgents/com.nanoclaw.imsg-reader.plist
plutil -lint /Library/LaunchAgents/com.nanoclaw.imsg-reader.plist >/dev/null
launchctl bootout "gui/$USER_ID/com.nanoclaw.imsg-reader" 2>/dev/null || true
launchctl bootstrap "gui/$USER_ID" /Library/LaunchAgents/com.nanoclaw.imsg-reader.plist

cat <<EOF

Installed. Next:
1. Full Disk Access for the reader, and nothing else new:
   System Settings > Privacy & Security > Full Disk Access > + > press Cmd-Shift-G,
   type $BIN/imsg-reader, Open, and switch it on.
   (If an older imsg-reader entry is there from a previous install, remove it: each build needs its own grant.)
2. sudo $BIN/imsg-reader-config run-now      lists your chats (names and members, no message text)
3. sudo $BIN/imsg-reader-config add-thread   pick the chat, name it and its members
4. sudo $BIN/imsg-reader-config setup off
5. sudo $BIN/imsg-reader-config run-now, then: sudo $BIN/imsg-reader-config verify
EOF
sudo -u "$USER_NAME" open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles" 2>/dev/null || true
