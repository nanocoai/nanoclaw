#!/usr/bin/env bash
#
# Install the iMessage adapter for the chosen backend and build. One channel,
# two backends; the backend is selected by env:
#   IMESSAGE_BACKEND   'local' | 'hosted'   (required)
#   IMESSAGE_ENABLED   'true'               (written for local; local reads chat.db)
#
# Hosted credentials (PHOTON_PROJECT_ID / PHOTON_PROJECT_SECRET) are written
# separately by the device-login wizard (scripts/photon-setup.ts), so this
# script asks for none. The Full Disk Access walkthrough (local) and the Photon
# wizard (hosted) live in setup/channels/imessage.ts. Non-interactive.
#
# Build-only: the caller restarts the service (setup/index.ts --step service, or
# the skill's restart step) after this returns. Idempotent — safe to re-run.
#
# Emits exactly one status block on stdout (ADD_IMESSAGE) at the end.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Keep in sync with .claude/skills/add-imessage/SKILL.md (Local + Hosted).
LOCAL_ADAPTER_VERSION="chat-adapter-imessage@0.1.1"
HOSTED_ADAPTER_VERSION="spectrum-ts@11.0.0"

# Resolve which remote carries the channels branch — handles forks where
# upstream lives on a different remote than `origin`.
# shellcheck source=setup/lib/channels-remote.sh
source "$PROJECT_ROOT/setup/lib/channels-remote.sh"
CHANNELS_REMOTE=$(resolve_channels_remote)
CHANNELS_BRANCH="${CHANNELS_REMOTE}/channels"

BACKEND="${IMESSAGE_BACKEND:-}"

emit_status() {
  local status=$1 error=${2:-}
  local already=${ADAPTER_ALREADY_INSTALLED:-false}
  echo "=== NANOCLAW SETUP: ADD_IMESSAGE ==="
  echo "STATUS: ${status}"
  [ -n "$BACKEND" ] && echo "BACKEND: ${BACKEND}"
  echo "ADAPTER_ALREADY_INSTALLED: ${already}"
  [ -n "$error" ] && echo "ERROR: ${error}"
  echo "=== END ==="
}

log() { echo "[add-imessage] $*" >&2; }

# Validate the backend and pick its package.
case "$BACKEND" in
  local)
    if [ "$(uname -s)" != "Darwin" ]; then
      emit_status failed "local backend requires macOS"
      exit 1
    fi
    ADAPTER_VERSION="$LOCAL_ADAPTER_VERSION"
    ADAPTER_PKG="chat-adapter-imessage"
    ;;
  hosted)
    ADAPTER_VERSION="$HOSTED_ADAPTER_VERSION"
    ADAPTER_PKG="spectrum-ts"
    ;;
  *)
    emit_status failed "IMESSAGE_BACKEND env var not set (expected local|hosted)"
    exit 1
    ;;
esac

# Each step below guards itself and never overwrites an existing file: some
# checkouts ship the adapter in trunk, and the channels-branch copy may be
# older than the working-tree one.
CHANGED=false

copy_needed=false
[ -f src/channels/imessage.ts ] || copy_needed=true
[ -f src/channels/imessage.test.ts ] || copy_needed=true
[ -f src/channels/imessage-registration.test.ts ] || copy_needed=true

if [ "$copy_needed" = true ]; then
  CHANGED=true
  log "Fetching channels branch…"
  git fetch "$CHANNELS_REMOTE" channels >&2 2>/dev/null || {
    emit_status failed "git fetch ${CHANNELS_REMOTE} channels failed"
    exit 1
  }

  log "Copying adapter from ${CHANNELS_BRANCH}…"
  [ -f src/channels/imessage.ts ] || \
    git show "${CHANNELS_BRANCH}:src/channels/imessage.ts" > src/channels/imessage.ts
  [ -f src/channels/imessage.test.ts ] || \
    git show "${CHANNELS_BRANCH}:src/channels/imessage.test.ts" > src/channels/imessage.test.ts
  [ -f src/channels/imessage-registration.test.ts ] || \
    git show "${CHANNELS_BRANCH}:src/channels/imessage-registration.test.ts" > src/channels/imessage-registration.test.ts
else
  log "Adapter present in working tree — keeping it (no fetch)."
fi

# Append self-registration import if missing.
if ! grep -q "^import './imessage.js';" src/channels/index.ts; then
  CHANGED=true
  echo "import './imessage.js';" >> src/channels/index.ts
fi

# Install the backend package if it isn't a dependency yet.
if ! grep -q "\"${ADAPTER_PKG}\"" package.json; then
  CHANGED=true
  log "Installing ${ADAPTER_VERSION}…"
  pnpm install "${ADAPTER_VERSION}" >&2 2>/dev/null || {
    emit_status failed "pnpm install ${ADAPTER_VERSION} failed"
    exit 1
  }
fi

ADAPTER_ALREADY_INSTALLED=true
if [ "$CHANGED" = true ]; then
  ADAPTER_ALREADY_INSTALLED=false
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

# Persist the backend selector. Local also needs IMESSAGE_ENABLED (it reads
# chat.db); hosted credentials are written by the device-login wizard.
upsert_env IMESSAGE_BACKEND "$BACKEND"
if [ "$BACKEND" = "local" ]; then
  upsert_env IMESSAGE_ENABLED "${IMESSAGE_ENABLED:-true}"
fi

# Strip legacy Chat-SDK remote-mode keys (dropped in the unified channel).
remove_env IMESSAGE_LOCAL
remove_env IMESSAGE_SERVER_URL
remove_env IMESSAGE_API_KEY

emit_status success
