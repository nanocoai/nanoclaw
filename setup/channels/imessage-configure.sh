#!/usr/bin/env bash
# Write the mode-exclusive iMessage `.env` keys, and strip the opposite mode's
# keys so a stale value can't confuse the adapter's factory.
#
# The two iMessage modes use different keys:
#   local  — IMESSAGE_LOCAL=true, IMESSAGE_ENABLED=true   (no server/key)
#   remote — IMESSAGE_LOCAL=false, IMESSAGE_SERVER_URL, IMESSAGE_API_KEY
#
# This is an upsert-and-remove: it replaces a key in place if present (else
# appends it) and deletes the other mode's keys. The skill engine's plain
# env write is set-if-absent only — it can neither replace a stale value nor
# delete a key — so that logic lives here, in one script the skill invokes
# once per mode.
#
#   bash setup/channels/imessage-configure.sh local
#   bash setup/channels/imessage-configure.sh remote "<server-url>" "<api-key>"
set -u

mode="${1:-}"
server_url="${2:-}"
api_key="${3:-}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
env_file="$root/.env"

# Replace `KEY=...` in place if present, else append it. Mirrors
# setup/environment.ts:upsertEnvKey (set-or-replace, file ends with a newline).
set_key() {
  local key="$1" val="$2" tmp found=0
  tmp="$(mktemp)"
  if [ -f "$env_file" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        "${key}="*) printf '%s=%s\n' "$key" "$val" >> "$tmp"; found=1 ;;
        *) printf '%s\n' "$line" >> "$tmp" ;;
      esac
    done < "$env_file"
  fi
  [ "$found" -eq 0 ] && printf '%s=%s\n' "$key" "$val" >> "$tmp"
  mv "$tmp" "$env_file"
}

# Drop every `KEY=...` line. Mirrors setup/environment.ts removeEnvKey.
remove_key() {
  local key="$1" tmp
  [ -f "$env_file" ] || return 0
  tmp="$(mktemp)"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "${key}="*) ;;
      *) printf '%s\n' "$line" >> "$tmp" ;;
    esac
  done < "$env_file"
  mv "$tmp" "$env_file"
}

case "$mode" in
  local)
    set_key IMESSAGE_LOCAL true
    set_key IMESSAGE_ENABLED true
    remove_key IMESSAGE_SERVER_URL
    remove_key IMESSAGE_API_KEY
    ;;
  remote)
    set_key IMESSAGE_LOCAL false
    set_key IMESSAGE_SERVER_URL "$server_url"
    set_key IMESSAGE_API_KEY "$api_key"
    remove_key IMESSAGE_ENABLED
    ;;
  *)
    echo "imessage-configure: unknown mode '${mode}' (expected local|remote)" >&2
    exit 1
    ;;
esac
