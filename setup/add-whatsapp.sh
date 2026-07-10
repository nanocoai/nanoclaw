#!/usr/bin/env bash
#
# Install the native WhatsApp (Baileys) adapter and its whatsapp-auth + groups
# setup steps. No credentials in env — WhatsApp uses linked-device auth, run
# by the whatsapp-auth step as a separate process. The adapter's factory
# returns null until store/auth/creds.json exists, so it's safe to install
# this before auth runs; the driver restarts the service *after* auth
# succeeds.
#
# Emits exactly one status block on stdout (ADD_WHATSAPP) at the end. All
# chatty progress messages go to stderr so setup:auto's raw-log capture sees
# the full story without cluttering the final block for the parser.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Keep in sync with .claude/skills/add-whatsapp/SKILL.md.
BAILEYS_VERSION="@whiskeysockets/baileys@7.0.0-rc.9"
QRCODE_VERSION="qrcode@1.5.4"
QRCODE_TYPES_VERSION="@types/qrcode@1.5.6"
PINO_VERSION="pino@9.6.0"

# Resolve which remote carries the channels branch — handles forks where
# upstream lives on a different remote than `origin`.
# shellcheck source=setup/lib/channels-remote.sh
source "$PROJECT_ROOT/setup/lib/channels-remote.sh"
CHANNELS_REMOTE=$(resolve_channels_remote)
CHANNELS_BRANCH="${CHANNELS_REMOTE}/channels"

emit_status() {
  local status=$1 error=${2:-}
  local already=${ADAPTER_ALREADY_INSTALLED:-false}
  echo "=== NANOCLAW SETUP: ADD_WHATSAPP ==="
  echo "STATUS: ${status}"
  echo "ADAPTER_ALREADY_INSTALLED: ${already}"
  [ -n "$error" ] && echo "ERROR: ${error}"
  echo "=== END ==="
}

log() { echo "[add-whatsapp] $*" >&2; }

need_install() {
  [ ! -f src/channels/whatsapp.ts ] && return 0
  [ ! -f setup/groups.ts ] && return 0
  [ ! -f container/skills/whatsapp-formatting/instructions.md ] && return 0
  ! grep -q "^import './whatsapp.js';" src/channels/index.ts 2>/dev/null && return 0
  ! grep -q "'whatsapp-auth':" setup/index.ts 2>/dev/null && return 0
  ! grep -q "^  groups:" setup/index.ts 2>/dev/null && return 0
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

  # whatsapp-auth.ts is maintained in this branch (setup-auto) — do not copy
  # from channels. Matches the pair-telegram.ts pattern.
  log "Copying adapter + group step from ${CHANNELS_BRANCH}…"
  git show "${CHANNELS_BRANCH}:src/channels/whatsapp.ts" > src/channels/whatsapp.ts
  git show "${CHANNELS_BRANCH}:setup/groups.ts"          > setup/groups.ts

  # WhatsApp formatting container skill — feeds the composed CLAUDE.md
  # (skill-whatsapp-formatting.md fragment) and ~/.claude/skills.
  mkdir -p container/skills/whatsapp-formatting
  git show "${CHANNELS_BRANCH}:container/skills/whatsapp-formatting/SKILL.md"        > container/skills/whatsapp-formatting/SKILL.md
  git show "${CHANNELS_BRANCH}:container/skills/whatsapp-formatting/instructions.md" > container/skills/whatsapp-formatting/instructions.md

  # Append self-registration import if missing.
  if ! grep -q "^import './whatsapp.js';" src/channels/index.ts; then
    echo "import './whatsapp.js';" >> src/channels/index.ts
  fi

  # Register the setup steps in setup/index.ts's STEPS map. node (not sed) —
  # sed's in-place + escape semantics differ between BSD (macOS) and GNU.
  node -e '
    const fs = require("fs");
    const p = "setup/index.ts";
    let s = fs.readFileSync(p, "utf-8");
    let changed = false;
    if (!s.includes("\047whatsapp-auth\047:")) {
      s = s.replace(
        /(register: \(\) => import\(\x27\.\/register\.js\x27\),)/,
        "$1\n  \x27whatsapp-auth\x27: () => import(\x27./whatsapp-auth.js\x27),"
      );
      changed = true;
    }
    if (!/^\s*groups:\s/m.test(s)) {
      s = s.replace(
        /(register: \(\) => import\(\x27\.\/register\.js\x27\),)/,
        "$1\n  groups: () => import(\x27./groups.js\x27),"
      );
      changed = true;
    }
    if (changed) fs.writeFileSync(p, s);
  '

  log "Installing Baileys + QR + pino (pinned)…"
  pnpm install \
    "${BAILEYS_VERSION}" \
    "${QRCODE_VERSION}" \
    "${QRCODE_TYPES_VERSION}" \
    "${PINO_VERSION}" \
    >&2 2>/dev/null || {
    emit_status failed "pnpm install failed"
    exit 1
  }

  log "Building…"
  pnpm run build >&2 2>/dev/null || {
    emit_status failed "pnpm run build failed"
    exit 1
  }
else
  log "Adapter + setup steps already installed — skipping install phase."
fi

# No service restart here — the adapter factory returns null without
# store/auth/creds.json, so restarting now would no-op. The driver restarts
# the service AFTER whatsapp-auth completes so the adapter picks up creds.

emit_status success
