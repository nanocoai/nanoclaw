#!/usr/bin/env bash
set -euo pipefail

# Variant of register-claude-token.sh that UPDATES the existing Anthropic
# vault secret with a long-lived `claude setup-token` token, instead of
# creating a duplicate. Run this in a real terminal (not inside Claude Code).
#
# The long-lived sk-ant-oat… token does not expire like the ~8h subscription
# OAuth access token, so once it's in the vault the agent stops going silent.

export PATH="/home/exedev/.local/bin:$PATH"

SECRET_ID="${SECRET_ID:-eb301f70-4f02-40b8-8580-5fa768193d5c}"

command -v onecli >/dev/null \
  || { echo "onecli not found." >&2; exit 1; }
command -v claude >/dev/null \
  || { echo "claude CLI not found." >&2; exit 1; }
command -v script >/dev/null \
  || { echo "script(1) is required for PTY capture." >&2; exit 1; }

tmpfile=$(mktemp -t claude-setup-token.XXXXXX)
trap 'rm -f "$tmpfile"' EXIT

cat <<'EOF'
A sign-in link will appear. Open it in your browser, sign in with your
Claude account, and paste back the code if asked. When done, the token is
saved to your OneCLI vault automatically.

Press Enter to continue.
EOF
read -r _ </dev/tty

if script --version 2>/dev/null | grep -q util-linux; then
  script -q -c "claude setup-token" "$tmpfile"
else
  script -q "$tmpfile" claude setup-token
fi

token=$(sed $'s/\x1b\\[[0-9;]*[a-zA-Z]//g' "$tmpfile" \
        | tr -d '\n\r' \
        | perl -ne 'print "$1\n" while /(sk-ant-oat[A-Za-z0-9_-]{80,500}AA)/g' \
        | tail -1 || true)

if [ -z "$token" ]; then
  keep=$(mktemp -t claude-setup-token-log.XXXXXX)
  cp "$tmpfile" "$keep"
  echo >&2
  echo "No sk-ant-oat…AA token found. Raw log: $keep" >&2
  exit 1
fi

echo
echo "Got long-lived token: ${token:0:16}…${token: -4}"
echo "Updating vault secret $SECRET_ID…"

onecli secrets update --id "$SECRET_ID" --value "$token"

echo "Done. The agent now uses a non-expiring token."
