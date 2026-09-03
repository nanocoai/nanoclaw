#!/bin/bash
set -euo pipefail

# setup.sh — Bootstrap script for NanoClaw
# Handles Node.js/pnpm setup, then hands off to the Node.js setup modules.
# This is the only bash script in the setup flow.

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Where verbose bootstrap logs go. nanoclaw.sh captures setup.sh's stdout to
# the per-step raw log, but legacy code in this script + install-node.sh
# also calls `log` which writes to a file. Route those to the raw log so
# they don't contaminate the progression log (logs/setup.log).
# Default: write to the raw bootstrap log if nanoclaw.sh pointed us there,
# else fall back to a dedicated bootstrap log (keeps standalone `bash
# setup.sh` invocations working).
LOG_FILE="${NANOCLAW_BOOTSTRAP_LOG:-${PROJECT_ROOT}/logs/bootstrap.log}"

mkdir -p "$(dirname "$LOG_FILE")"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [bootstrap] $*" >> "$LOG_FILE"; }

# --- Platform detection ---

detect_platform() {
  local uname_s
  uname_s=$(uname -s)
  case "$uname_s" in
    Darwin*) PLATFORM="macos" ;;
    Linux*)  PLATFORM="linux" ;;
    *)       PLATFORM="unknown" ;;
  esac

  IS_WSL="false"
  if [ "$PLATFORM" = "linux" ] && [ -f /proc/version ]; then
    if grep -qi 'microsoft\|wsl' /proc/version 2>/dev/null; then
      IS_WSL="true"
    fi
  fi

  IS_ROOT="false"
  if [ "$(id -u)" -eq 0 ]; then
    IS_ROOT="true"
  fi

  log "Platform: $PLATFORM, WSL: $IS_WSL, Root: $IS_ROOT"
}

# --- Node.js check ---

check_node() {
  NODE_OK="false"
  NODE_VERSION="not_found"
  NODE_PATH_FOUND=""

  if command -v node >/dev/null 2>&1; then
    NODE_VERSION=$(node --version 2>/dev/null | sed 's/^v//')
    NODE_PATH_FOUND=$(command -v node)
    local major
    major=$(echo "$NODE_VERSION" | cut -d. -f1)
    if [ "$major" -ge 22 ] 2>/dev/null; then
      NODE_OK="true"
    fi
    log "Node $NODE_VERSION at $NODE_PATH_FOUND (major=$major, ok=$NODE_OK)"
  else
    log "Node not found"
  fi
}

# --- pnpm install ---

install_deps() {
  DEPS_OK="false"
  NATIVE_OK="false"

  if [ "$NODE_OK" = "false" ]; then
    log "Skipping pnpm install — Node not available"
    return
  fi

  cd "$PROJECT_ROOT"

  # Corepack's first-use "Do you want to continue? [Y/n]" prompt would hang
  # the script since we redirect stdout/stderr to the log file — the prompt
  # is invisible but corepack still blocks on stdin. Auto-accept.
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

  # Preferred path: enable corepack so `pnpm` shim lands on PATH.
  if command -v corepack >/dev/null 2>&1; then
    log "Enabling corepack"
    corepack enable >> "$LOG_FILE" 2>&1 || true

    # On Linux/WSL with system-wide Node (e.g. apt-installed to /usr/bin),
    # corepack needs root to symlink /usr/bin/pnpm. macOS Homebrew installs
    # land in a user-writable prefix, and a sudo retry there would create
    # root-owned shims inside /opt/homebrew that later break brew — so the
    # retry is Linux-only.
    if ! command -v pnpm >/dev/null 2>&1 && [ "$PLATFORM" = "linux" ] \
        && command -v sudo >/dev/null 2>&1; then
      log "pnpm not on PATH after corepack enable — retrying with sudo"
      sudo corepack enable >> "$LOG_FILE" 2>&1 || true
    fi
  else
    log "corepack not available — will fall back to npm-install pnpm"
  fi

  # Fallback: some Node installs (older nvm, node@22 keg-only, minimal
  # distro packages) don't include corepack. Install pnpm directly at the
  # version pinned via package.json's `packageManager` field.
  if ! command -v pnpm >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    local pinned
    pinned=$(grep -E '"packageManager"' "$PROJECT_ROOT/package.json" 2>/dev/null \
      | head -1 \
      | sed -E 's/.*"pnpm@([^"]+)".*/\1/')
    [ -z "$pinned" ] && pinned="latest"
    log "Installing pnpm@${pinned} via npm"
    npm install -g "pnpm@${pinned}" >> "$LOG_FILE" 2>&1 \
      || ([ "$PLATFORM" = "linux" ] && command -v sudo >/dev/null 2>&1 \
            && sudo npm install -g "pnpm@${pinned}" >> "$LOG_FILE" 2>&1) \
      || true
  fi

  # `npm install -g` writes to npm's global prefix, which isn't always on the
  # shell PATH — common on macOS where the user has `npm config set prefix
  # ~/.npm-global` to avoid sudo, or on Linux where /usr/local/bin isn't in
  # PATH. Discover the prefix and prepend its bin dir so `command -v pnpm`
  # sees the new install.
  if ! command -v pnpm >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    local npm_prefix
    npm_prefix=$(npm config get prefix 2>/dev/null)
    if [ -n "$npm_prefix" ] && [ -x "$npm_prefix/bin/pnpm" ]; then
      export PATH="$npm_prefix/bin:$PATH"
      log "Prepended npm prefix bin to PATH: $npm_prefix/bin"
    fi
  fi

  if ! command -v pnpm >/dev/null 2>&1; then
    log "pnpm not on PATH after corepack + npm fallback"
    return
  fi

  log "Running pnpm install --frozen-lockfile"
  if pnpm install --frozen-lockfile >> "$LOG_FILE" 2>&1; then
    DEPS_OK="true"
    log "pnpm install succeeded"
  else
    log "pnpm install failed"
    return
  fi

  # Verify native module (better-sqlite3)
  log "Verifying native modules"
  if node -e "require('better-sqlite3')" >> "$LOG_FILE" 2>&1; then
    NATIVE_OK="true"
    log "better-sqlite3 loads OK"
  else
    log "better-sqlite3 failed to load"
  fi
}

# --- Build tools check ---

check_build_tools() {
  HAS_BUILD_TOOLS="false"

  if [ "$PLATFORM" = "macos" ]; then
    if xcode-select -p >/dev/null 2>&1; then
      HAS_BUILD_TOOLS="true"
    fi
  elif [ "$PLATFORM" = "linux" ]; then
    if command -v gcc >/dev/null 2>&1 && command -v make >/dev/null 2>&1; then
      HAS_BUILD_TOOLS="true"
    fi
  fi

  log "Build tools: $HAS_BUILD_TOOLS"
}

# --- Main ---

log "=== Bootstrap started ==="

detect_platform

check_node
if [ "$NODE_OK" = "false" ]; then
  log "Node missing or too old — running setup/install-node.sh"
  echo "Node 22+ not found — installing via setup/install-node.sh"
  if bash "$PROJECT_ROOT/setup/install-node.sh" 2>&1 | tee -a "$LOG_FILE"; then
    if [ -x "$HOME/.local/bin/node" ]; then
      export PATH="$HOME/.local/bin:$PATH"
    elif [ "$PLATFORM" = "macos" ] && command -v brew >/dev/null 2>&1; then
      if NODE22_PREFIX="$(brew --prefix node@22 2>/dev/null)"; then
        export PATH="$NODE22_PREFIX/bin:$PATH"
      fi
    fi
    hash -r 2>/dev/null || true
    check_node
  else
    log "install-node.sh failed"
  fi
fi
install_deps
check_build_tools

# Emit status block
STATUS="success"
if [ "$NODE_OK" = "false" ]; then
  STATUS="node_missing"
elif [ "$DEPS_OK" = "false" ]; then
  STATUS="deps_failed"
elif [ "$NATIVE_OK" = "false" ]; then
  STATUS="native_failed"
fi

# Anonymous setup start event (non-blocking, best-effort). Uses the
# persisted distinct_id from data/install-id so bash-side events and the
# node-side funnel share one id.
# shellcheck source=setup/lib/diagnostics.sh
source "$PROJECT_ROOT/setup/lib/diagnostics.sh"
ph_event setup_start \
  platform="$PLATFORM" \
  is_wsl="$IS_WSL" \
  is_root="$IS_ROOT" \
  node_version="$NODE_VERSION" \
  deps_ok="$DEPS_OK" \
  native_ok="$NATIVE_OK" \
  has_build_tools="$HAS_BUILD_TOOLS" \
  status="$STATUS"

cat <<EOF
=== NANOCLAW SETUP: BOOTSTRAP ===
PLATFORM: $PLATFORM
IS_WSL: $IS_WSL
IS_ROOT: $IS_ROOT
NODE_VERSION: $NODE_VERSION
NODE_OK: $NODE_OK
NODE_PATH: ${NODE_PATH_FOUND:-not_found}
DEPS_OK: $DEPS_OK
NATIVE_OK: $NATIVE_OK
HAS_BUILD_TOOLS: $HAS_BUILD_TOOLS
STATUS: $STATUS
LOG: logs/setup.log
=== END ===
EOF

log "=== Bootstrap completed: $STATUS ==="

if [ "$NODE_OK" = "false" ]; then
  exit 2
fi
if [ "$DEPS_OK" = "false" ] || [ "$NATIVE_OK" = "false" ]; then
  exit 1
fi
