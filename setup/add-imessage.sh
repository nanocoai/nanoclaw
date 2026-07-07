#!/usr/bin/env bash
#
# Install the iMessage adapter, persist mode/creds to .env,
# and restart the service. Non-interactive — the Full Disk Access walkthrough
# (local mode) and Photon URL/key prompts (remote mode) live in
# setup/channels/imessage.ts. Creds come in via env vars:
#   IMESSAGE_LOCAL   'true' | 'false'  (required)
#   IMESSAGE_ENABLED 'true'            (required when IMESSAGE_LOCAL=true)
#   IMESSAGE_SERVER_URL                (required when IMESSAGE_LOCAL=false)
#   IMESSAGE_API_KEY                   (required when IMESSAGE_LOCAL=false)
#
# Emits exactly one status block on stdout (ADD_IMESSAGE) at the end.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Keep in sync with .claude/skills/add-imessage/SKILL.md.
ADAPTER_VERSION="chat-adapter-imessage@0.1.1"

# Resolve which remote carries the channels branch — handles forks where
# upstream lives on a different remote than `origin`.
# shellcheck source=setup/lib/channels-remote.sh
source "$PROJECT_ROOT/setup/lib/channels-remote.sh"
CHANNELS_REMOTE=$(resolve_channels_remote)
CHANNELS_BRANCH="${CHANNELS_REMOTE}/channels"

emit_status() {
  local status=$1 error=${2:-}
  local already=${ADAPTER_ALREADY_INSTALLED:-false}
  local mode=${IMESSAGE_LOCAL:-}
  echo "=== NANOCLAW SETUP: ADD_IMESSAGE ==="
  echo "STATUS: ${status}"
  echo "ADAPTER_VERSION: ${ADAPTER_VERSION}"
  echo "ADAPTER_ALREADY_INSTALLED: ${already}"
  [ -n "$mode" ] && echo "MODE: $([ "$mode" = "true" ] && echo local || echo remote)"
  [ -n "$error" ] && echo "ERROR: ${error}"
  echo "=== END ==="
}

log() { echo "[add-imessage] $*" >&2; }

# Validate creds based on mode.
if [ -z "${IMESSAGE_LOCAL:-}" ]; then
  emit_status failed "IMESSAGE_LOCAL env var not set (expected true|false)"
  exit 1
fi
if [ "${IMESSAGE_LOCAL}" = "true" ]; then
  if [ -z "${IMESSAGE_ENABLED:-}" ]; then
    emit_status failed "IMESSAGE_ENABLED env var not set for local mode"
    exit 1
  fi
  if [ "$(uname -s)" != "Darwin" ]; then
    emit_status failed "local mode requires macOS"
    exit 1
  fi
else
  if [ -z "${IMESSAGE_SERVER_URL:-}" ]; then
    emit_status failed "IMESSAGE_SERVER_URL env var not set for remote mode"
    exit 1
  fi
  if [ -z "${IMESSAGE_API_KEY:-}" ]; then
    emit_status failed "IMESSAGE_API_KEY env var not set for remote mode"
    exit 1
  fi
fi

need_install() {
  [ ! -f src/channels/imessage.ts ] && return 0
  ! grep -q "^import './imessage.js';" src/channels/index.ts 2>/dev/null && return 0
  return 1
}

ADAPTER_ALREADY_INSTALLED=true
if need_install; then
  ADAPTER_ALREADY_INSTALLED=false
  log "Fetching channels branch…"
  git fetch "$CHANNELS_REMOTE" channels >&2 2>/dev/null || {
    emit_status failed "git fetch ${CHANNELS_REMOTE} channels failed"
    exit 1
  }

  log "Copying adapter from ${CHANNELS_BRANCH}…"
  git show "${CHANNELS_BRANCH}:src/channels/imessage.ts" > src/channels/imessage.ts

  # Append self-registration import if missing.
  if ! grep -q "^import './imessage.js';" src/channels/index.ts; then
    echo "import './imessage.js';" >> src/channels/index.ts
  fi

  log "Installing ${ADAPTER_VERSION}…"
  pnpm install "${ADAPTER_VERSION}" >&2 2>/dev/null || {
    emit_status failed "pnpm install ${ADAPTER_VERSION} failed"
    exit 1
  }

  log "Building…"
  pnpm run build >&2 2>/dev/null || {
    emit_status failed "pnpm run build failed"
    exit 1
  }
else
  log "Adapter files already installed — skipping install phase."
fi

touch .env
upsert_env() {
  local key=$1 value=$2
  if grep -q "^${key}=" .env; then
    awk -v k="$key" -v v="$value" \
        'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' \
      .env > .env.tmp && mv .env.tmp .env
  else
    echo "${key}=${value}" >> .env
  fi
}

remove_env() {
  local key=$1
  if grep -q "^${key}=" .env 2>/dev/null; then
    grep -v "^${key}=" .env > .env.tmp && mv .env.tmp .env
  fi
}

# Write the canonical keys for the chosen mode, strip the opposite mode's
# keys so stale values can't confuse the adapter's factory.
upsert_env IMESSAGE_LOCAL "$IMESSAGE_LOCAL"
if [ "$IMESSAGE_LOCAL" = "true" ]; then
  upsert_env IMESSAGE_ENABLED "$IMESSAGE_ENABLED"
  remove_env IMESSAGE_SERVER_URL
  remove_env IMESSAGE_API_KEY
else
  upsert_env IMESSAGE_SERVER_URL "$IMESSAGE_SERVER_URL"
  upsert_env IMESSAGE_API_KEY "$IMESSAGE_API_KEY"
  remove_env IMESSAGE_ENABLED
fi

log "Restarting service so the new adapter picks up the creds…"
# shellcheck source=setup/lib/install-slug.sh
source "$PROJECT_ROOT/setup/lib/install-slug.sh"
case "$(uname -s)" in
  Darwin)
    launchctl kickstart -k "gui/$(id -u)/$(launchd_label)" >&2 2>/dev/null || true
    ;;
  Linux)
    systemctl --user restart "$(systemd_unit)" >&2 2>/dev/null \
      || sudo systemctl restart "$(systemd_unit)" >&2 2>/dev/null \
      || true
    ;;
esac

# Give the adapter a moment to open chat.db (local) or handshake with
# Photon (remote) before emitting success.
sleep 3

emit_status success
