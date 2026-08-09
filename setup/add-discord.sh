#!/usr/bin/env bash
#
# Install the Discord adapter, persist DISCORD_BOT_TOKEN / APPLICATION_ID /
# PUBLIC_KEY to .env + data/env/env, and restart the service. Non-interactive —
# the operator-facing "Create a bot" walkthrough, owner confirmation, and
# server-invite step live in setup/channels/discord.ts. Credentials come in via
# env vars: DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID, DISCORD_PUBLIC_KEY.
#
# Emits exactly one status block on stdout (ADD_DISCORD) at the end. All chatty
# progress messages go to stderr so setup:auto's raw-log capture sees the full
# story without cluttering the final block for the parser.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Keep in sync with .claude/skills/add-discord/SKILL.md.
ADAPTER_VERSION="@chat-adapter/discord@4.29.0"

# Resolve which remote carries the channels branch — handles forks where
# upstream lives on a different remote than `origin`.
# shellcheck source=setup/lib/channels-remote.sh
source "$PROJECT_ROOT/setup/lib/channels-remote.sh"
CHANNELS_REMOTE=$(resolve_channels_remote)
CHANNELS_BRANCH="${CHANNELS_REMOTE}/channels"

emit_status() {
  local status=$1 error=${2:-}
  local already=${ADAPTER_ALREADY_INSTALLED:-false}
  echo "=== NANOCLAW SETUP: ADD_DISCORD ==="
  echo "STATUS: ${status}"
  echo "ADAPTER_VERSION: ${ADAPTER_VERSION}"
  echo "ADAPTER_ALREADY_INSTALLED: ${already}"
  [ -n "$error" ] && echo "ERROR: ${error}"
  echo "=== END ==="
}

log() { echo "[add-discord] $*" >&2; }

if [ -z "${DISCORD_BOT_TOKEN:-}" ]; then
  emit_status failed "DISCORD_BOT_TOKEN env var not set"
  exit 1
fi
if [ -z "${DISCORD_APPLICATION_ID:-}" ]; then
  emit_status failed "DISCORD_APPLICATION_ID env var not set"
  exit 1
fi
if [ -z "${DISCORD_PUBLIC_KEY:-}" ]; then
  emit_status failed "DISCORD_PUBLIC_KEY env var not set"
  exit 1
fi

need_install() {
  [ ! -f src/channels/discord.ts ] && return 0
  ! grep -q "^import './discord.js';" src/channels/index.ts 2>/dev/null && return 0
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
  git show "${CHANNELS_BRANCH}:src/channels/discord.ts" > src/channels/discord.ts

  # Append self-registration import if missing.
  if ! grep -q "^import './discord.js';" src/channels/index.ts; then
    echo "import './discord.js';" >> src/channels/index.ts
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

# Persist credentials. auto.ts validates before this point, so bad values here
# would be an internal bug rather than operator input.
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
upsert_env DISCORD_BOT_TOKEN "$DISCORD_BOT_TOKEN"
upsert_env DISCORD_APPLICATION_ID "$DISCORD_APPLICATION_ID"
upsert_env DISCORD_PUBLIC_KEY "$DISCORD_PUBLIC_KEY"

# Container reads from data/env/env (the host mounts it).
mkdir -p data/env
cp .env data/env/env

log "Restarting service so the new adapter picks up the credentials…"
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

# Give the Discord adapter a moment to finish gateway handshake before
# init-first-agent attempts delivery.
sleep 5

emit_status success
