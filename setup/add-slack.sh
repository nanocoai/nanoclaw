#!/usr/bin/env bash
#
# Install the Slack adapter, persist SLACK_BOT_TOKEN plus the mode-specific
# secret (SLACK_APP_TOKEN for Socket Mode, SLACK_SIGNING_SECRET for webhook) to
# .env + data/env/env, and restart the service. Non-interactive — the
# operator-facing app creation walkthrough + credential paste live in
# setup/channels/slack.ts. Credentials come in via env vars:
# SLACK_BOT_TOKEN, and SLACK_APP_TOKEN and/or SLACK_SIGNING_SECRET.
#
# Emits exactly one status block on stdout (ADD_SLACK) at the end. All chatty
# progress messages go to stderr so setup:auto's raw-log capture sees the full
# story without cluttering the final block for the parser.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Keep in sync with .claude/skills/add-slack/SKILL.md.
ADAPTER_VERSION="@chat-adapter/slack@4.29.0"

# Resolve which remote carries the channels branch — handles forks where
# upstream lives on a different remote than `origin`.
# shellcheck source=setup/lib/channels-remote.sh
source "$PROJECT_ROOT/setup/lib/channels-remote.sh"
CHANNELS_REMOTE=$(resolve_channels_remote)
CHANNELS_BRANCH="${CHANNELS_REMOTE}/channels"

emit_status() {
  local status=$1 error=${2:-}
  local already=${ADAPTER_ALREADY_INSTALLED:-false}
  echo "=== NANOCLAW SETUP: ADD_SLACK ==="
  echo "STATUS: ${status}"
  echo "ADAPTER_VERSION: ${ADAPTER_VERSION}"
  echo "ADAPTER_ALREADY_INSTALLED: ${already}"
  [ -n "$error" ] && echo "ERROR: ${error}"
  echo "=== END ==="
}

log() { echo "[add-slack] $*" >&2; }

if [ -z "${SLACK_BOT_TOKEN:-}" ]; then
  emit_status failed "SLACK_BOT_TOKEN env var not set"
  exit 1
fi
# Socket Mode authenticates with SLACK_APP_TOKEN; webhook mode with
# SLACK_SIGNING_SECRET. Require at least one.
if [ -z "${SLACK_APP_TOKEN:-}" ] && [ -z "${SLACK_SIGNING_SECRET:-}" ]; then
  emit_status failed "Set SLACK_APP_TOKEN (Socket Mode) or SLACK_SIGNING_SECRET (webhook)"
  exit 1
fi

need_install() {
  [ ! -f src/channels/slack.ts ] && return 0
  ! grep -q "^import './slack.js';" src/channels/index.ts 2>/dev/null && return 0
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
  git show "${CHANNELS_BRANCH}:src/channels/slack.ts" > src/channels/slack.ts

  # Append self-registration import if missing.
  if ! grep -q "^import './slack.js';" src/channels/index.ts; then
    echo "import './slack.js';" >> src/channels/index.ts
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

# Persist credentials. auto.ts validates via auth.test before this point, so
# bad values here would be an internal bug rather than operator input.
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
upsert_env SLACK_BOT_TOKEN "$SLACK_BOT_TOKEN"
if [ -n "${SLACK_APP_TOKEN:-}" ]; then
  upsert_env SLACK_APP_TOKEN "$SLACK_APP_TOKEN"
fi
if [ -n "${SLACK_SIGNING_SECRET:-}" ]; then
  upsert_env SLACK_SIGNING_SECRET "$SLACK_SIGNING_SECRET"
fi

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

# Give the Slack adapter a moment to finish starting the webhook listener
# before emitting success.
sleep 3

emit_status success
