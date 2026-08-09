#!/usr/bin/env bash
#
# Install the Telegram adapter, persist the bot token to .env + data/env/env,
# restart the service, and open the bot's chat page in the local Telegram
# client. Non-interactive — the operator-facing "Create a bot" instructions
# and token paste live in setup/auto.ts. The token comes in via the
# TELEGRAM_BOT_TOKEN env var.
#
# Emits exactly one status block on stdout (ADD_TELEGRAM) at the end. All
# chatty progress messages go to stderr so setup:auto's raw-log capture
# sees the full story without cluttering the final block for the parser.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Keep in sync with .claude/skills/add-telegram/SKILL.md.
ADAPTER_VERSION="@chat-adapter/telegram@4.29.0"

# Resolve which remote carries the channels branch — handles forks where
# upstream lives on a different remote than `origin`.
# shellcheck source=setup/lib/channels-remote.sh
source "$PROJECT_ROOT/setup/lib/channels-remote.sh"
CHANNELS_REMOTE=$(resolve_channels_remote)
CHANNELS_BRANCH="${CHANNELS_REMOTE}/channels"

emit_status() {
  local status=$1 error=${2:-}
  local already=${ADAPTER_ALREADY_INSTALLED:-false}
  local username=${BOT_USERNAME:-}
  echo "=== NANOCLAW SETUP: ADD_TELEGRAM ==="
  echo "STATUS: ${status}"
  echo "ADAPTER_VERSION: ${ADAPTER_VERSION}"
  echo "ADAPTER_ALREADY_INSTALLED: ${already}"
  [ -n "$username" ] && echo "BOT_USERNAME: ${username}"
  [ -n "$error" ] && echo "ERROR: ${error}"
  echo "=== END ==="
}

log() { echo "[add-telegram] $*" >&2; }

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
  emit_status failed "TELEGRAM_BOT_TOKEN env var not set"
  exit 1
fi

if ! [[ "$TELEGRAM_BOT_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]{35,}$ ]]; then
  emit_status failed "token format invalid (expected <digits>:<chars>)"
  exit 1
fi

need_install() {
  [ ! -f src/channels/telegram.ts ] && return 0
  ! grep -q "^import './telegram.js';" src/channels/index.ts 2>/dev/null && return 0
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

  # pair-telegram.ts is maintained in this branch (setup-auto), so it's NOT
  # in this list — do not overwrite the local version with the channels copy.
  log "Copying adapter files from ${CHANNELS_BRANCH}…"
  for f in \
    src/channels/telegram.ts \
    src/channels/telegram-pairing.ts \
    src/channels/telegram-pairing.test.ts \
    src/channels/telegram-markdown-sanitize.ts \
    src/channels/telegram-markdown-sanitize.test.ts
  do
    git show "${CHANNELS_BRANCH}:$f" > "$f"
  done

  # Append self-registration import if missing.
  if ! grep -q "^import './telegram.js';" src/channels/index.ts; then
    echo "import './telegram.js';" >> src/channels/index.ts
  fi

  # Register pair-telegram step if not already in the STEPS map.
  # Uses node (not sed) since sed's in-place + escape semantics differ
  # between BSD (macOS) and GNU.
  node -e '
    const fs = require("fs");
    const p = "setup/index.ts";
    let s = fs.readFileSync(p, "utf-8");
    if (!s.includes("\047pair-telegram\047")) {
      s = s.replace(
        /(register: \(\) => import\(\x27\.\/register\.js\x27\),)/,
        "$1\n  \x27pair-telegram\x27: () => import(\x27./pair-telegram.js\x27),"
      );
      fs.writeFileSync(p, s);
    }
  '

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

# Persist token. auto.ts validates before this point, so a bad token here
# would be an internal bug rather than operator input.
touch .env
if grep -q '^TELEGRAM_BOT_TOKEN=' .env; then
  awk -v tok="$TELEGRAM_BOT_TOKEN" \
      '/^TELEGRAM_BOT_TOKEN=/{print "TELEGRAM_BOT_TOKEN=" tok; next} {print}' \
    .env > .env.tmp && mv .env.tmp .env
else
  echo "TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}" >> .env
fi

# Look up the bot username (auto.ts already validated; we re-query here so
# standalone invocations still work — BOT_USERNAME is emitted in the status
# block for parent drivers to display).
INFO=$(curl -fsS --max-time 8 \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" 2>/dev/null || true)
BOT_USERNAME=""
if echo "$INFO" | grep -q '"ok":true'; then
  BOT_USERNAME=$(echo "$INFO" | sed -nE 's/.*"username":"([^"]+)".*/\1/p')
fi

# Container reads from data/env/env (the host mounts it).
mkdir -p data/env
cp .env data/env/env

# Browser/app deep-link is done by the parent driver (setup/channels/telegram.ts)
# BEFORE this script runs — gated on a clack confirm so focus-stealing doesn't
# surprise the user. Keeping it out of here means this script stays pure
# non-interactive install.

log "Restarting service so the new adapter picks up the token…"
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

# Give the Telegram adapter a moment to finish starting before pair-telegram
# begins polling for the user's code message.
sleep 5

emit_status success
