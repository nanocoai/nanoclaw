#!/usr/bin/env bash
# Write the backend-selecting iMessage `.env` keys, and strip a stale key from
# the opposite backend so it can't confuse the adapter's backend resolution.
#
# One `imessage` channel, two backends, selected by env:
#   local  — IMESSAGE_BACKEND=local, IMESSAGE_ENABLED=true (reads this Mac's chat.db)
#   hosted — IMESSAGE_BACKEND=hosted; the credentials (PHOTON_PROJECT_ID /
#            PHOTON_PROJECT_SECRET) are written by the device-login wizard
#            (scripts/photon-setup.ts), not here
#
# The explicit IMESSAGE_BACKEND selector wins in the adapter even when both
# backends' keys are present, but keeping .env unambiguous costs nothing. This
# is an upsert-and-remove: it replaces a key in place if present (else appends
# it) and deletes the other backend's stale key. The skill engine's plain env
# write is set-if-absent only — it can neither replace a stale value nor delete
# a key — so that logic lives here, in one script the skill invokes once per
# backend.
#
#   bash setup/channels/imessage-configure.sh local
#   bash setup/channels/imessage-configure.sh hosted
set -u

backend="${1:-}"

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

case "$backend" in
  local)
    set_key IMESSAGE_BACKEND local
    set_key IMESSAGE_ENABLED true
    ;;
  hosted)
    set_key IMESSAGE_BACKEND hosted
    remove_key IMESSAGE_ENABLED
    ;;
  *)
    echo "imessage-configure: unknown backend '${backend}' (expected local|hosted)" >&2
    exit 1
    ;;
esac
