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

# shellcheck source=setup/lib/node-version.sh
source "$PROJECT_ROOT/setup/lib/node-version.sh"
# shellcheck source=setup/lib/jq.sh
source "$PROJECT_ROOT/setup/lib/jq.sh"

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

# --- Why a tool failed ---

# Tools write straight to the log, and the one line for the screen is read
# back from it.

# log_end_line: a tool may end without a newline; what the log gets next
# must start on a line of its own.
log_end_line() {
  [ -z "$(tail -c 1 "$LOG_FILE" 2>/dev/null)" ] || echo >> "$LOG_FILE"
}

# log_mark: LOG_MARK is how many lines the log holds now. It is left empty
# when they cannot be counted, and log_error_line then gives nothing: better
# no line than one from an earlier step.
log_mark() {
  log_end_line
  if [ -e "$LOG_FILE" ]; then
    LOG_MARK=$(wc -l 2>/dev/null < "$LOG_FILE") || LOG_MARK=""
  else
    LOG_MARK=0
  fi
  # BSD wc pads the count with spaces.
  LOG_MARK="${LOG_MARK//[[:space:]]/}"
  case "$LOG_MARK" in
    *[!0-9]*) LOG_MARK="" ;;
  esac
}

# log_error_line: sets ERROR_LINE to the first line the log gained since
# log_mark that names an error, else to the first with anything on it.
log_error_line() {
  local line n=0
  ERROR_LINE=""
  [ -n "${LOG_MARK:-}" ] || return 0
  [ -r "$LOG_FILE" ] || return 0
  log_end_line
  while IFS= read -r line; do
    n=$((n + 1))
    [ "$n" -gt "$LOG_MARK" ] || continue
    [ -n "$ERROR_LINE" ] || ERROR_LINE="$line"
    case "$line" in
      *[Ee]rror* | *ERR!*) ERROR_LINE="$line"; return 0 ;;
    esac
  done < "$LOG_FILE"
  return 0
}

# --- Node.js check ---

check_node() {
  NODE_OK="false"
  NODE_VERSION="not_found"
  NODE_PATH_FOUND=""
  NODE_START_ERROR=""

  if command -v node >/dev/null 2>&1; then
    NODE_PATH_FOUND=$(command -v node)
    # Guarded: under `set -e` a Node that cannot start (built for another
    # libc, a broken download) would end the bootstrap here with nothing said.
    # Run once: what it prints on stderr goes to the log.
    log_mark
    if NODE_VERSION=$(node --version 2>>"$LOG_FILE"); then
      NODE_VERSION="${NODE_VERSION#v}"
      if node_meets_minimum "$NODE_VERSION"; then
        NODE_OK="true"
      fi
      log "Node $NODE_VERSION at $NODE_PATH_FOUND (ok=$NODE_OK)"
    else
      # Its stdout may hold the error too.
      [ -z "$NODE_VERSION" ] || printf '\n%s\n' "$NODE_VERSION" >> "$LOG_FILE"
      NODE_VERSION="cannot_start"
      log_error_line
      NODE_START_ERROR="$ERROR_LINE"
      log "Node at $NODE_PATH_FOUND cannot start: ${NODE_START_ERROR:-it printed nothing}"
    fi
  else
    log "Node not found"
  fi
}

# --- Node.js install ---

ensure_node() {
  check_node
  # An earlier install may have left a Node that meets the minimum off PATH.
  if [ "$NODE_OK" = "false" ] && node_use_patched; then
    check_node
  fi
  # install-node.sh decides what to install from the version of the PATH Node.
  # One that cannot start has none to give, so nothing is installed over it.
  if [ "$NODE_OK" = "false" ] && [ "$NODE_VERSION" != "cannot_start" ]; then
    log "Node missing or too old — running setup/install-node.sh"
    echo "Node is missing or below the minimum (${NODE_MINIMUMS// / / }) — installing via setup/install-node.sh"
    if bash "$PROJECT_ROOT/setup/install-node.sh" 2>&1 | tee -a "$LOG_FILE"; then
      node_use_patched || true
      check_node
    else
      log "install-node.sh failed"
    fi
  fi
  # Say why and what to do; the status block ends the run as node_missing.
  if [ "$NODE_VERSION" = "cannot_start" ]; then
    echo "Node at $NODE_PATH_FOUND cannot start:"
    echo "  ${NODE_START_ERROR:-it printed nothing}"
    echo "Remove it, or put a Node that works (${NODE_MINIMUMS// / / } or newer) ahead of it on PATH, then re-run setup."
  fi
}

# --- jq (skills read API replies with it) ---

install_jq() {
  JQ_OK="false"
  if ensure_jq >> "$LOG_FILE" 2>&1; then
    JQ_OK="true"
  fi
  log "jq: $JQ_OK"
}

# --- pnpm install ---

install_deps() {
  DEPS_OK="false"
  NATIVE_OK="false"
  # Set where a try that needs no root fails: why pnpm is missing, the tool's
  # own error line and what to do. The message at the end prints the last one.
  local pnpm_why="" pnpm_error="" pnpm_todo=""

  if [ "$NODE_OK" = "false" ]; then
    log "Skipping pnpm install — Node not available"
    return
  fi

  cd "$PROJECT_ROOT"

  # Corepack's first-use "Do you want to continue? [Y/n]" prompt would hang
  # the script since we redirect stdout/stderr to the log file — the prompt
  # is invisible but corepack still blocks on stdin. Auto-accept.
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

  # The pnpm lookups below append to PATH, so a node in those dirs can't
  # shadow the one check_node accepted.

  # A previous run (or the manual recovery printed below) may have left pnpm
  # in ~/.local/bin, which a fresh login shell doesn't always have on PATH.
  if ! command -v pnpm >/dev/null 2>&1 && [ -x "$HOME/.local/bin/pnpm" ]; then
    export PATH="$PATH:$HOME/.local/bin"
    log "Found pnpm in $HOME/.local/bin — appended to PATH"
  fi

  # Preferred path: enable corepack so `pnpm` shim lands on PATH.
  if command -v corepack >/dev/null 2>&1; then
    log "Enabling corepack"
    corepack enable >> "$LOG_FILE" 2>&1 || true

    # With system-wide Node (e.g. apt-installed to /usr/bin), corepack puts
    # its shims next to the node binary, so a non-root user gets EACCES on
    # /usr/bin/pnpm. Retry into ~/.local/bin, which needs no root — nanoclaw.sh
    # and the service unit already carry it on PATH.
    if ! command -v pnpm >/dev/null 2>&1; then
      local user_bin="$HOME/.local/bin"
      log "pnpm not on PATH after corepack enable — retrying into $user_bin"
      log_mark
      if ! mkdir -p "$user_bin" >> "$LOG_FILE" 2>&1; then
        pnpm_why="$user_bin cannot be created"
        log_error_line
        pnpm_error="$ERROR_LINE"
        pnpm_todo="Fix that, then re-run setup. mkdir's full output is in $LOG_FILE"
        log "Could not create $user_bin: $pnpm_error"
      elif corepack enable --install-directory "$user_bin" pnpm >> "$LOG_FILE" 2>&1 \
          && [ -x "$user_bin/pnpm" ]; then
        export PATH="$PATH:$user_bin"
        hash -r 2>/dev/null || true
        log "corepack pnpm shim installed in $user_bin"
      else
        # This try needs no root, so what corepack said is why pnpm is missing.
        pnpm_why="corepack could not put pnpm into $user_bin"
        log_error_line
        pnpm_error="$ERROR_LINE"
        pnpm_todo="Fix that, then re-run setup. corepack's full output is in $LOG_FILE"
        log "corepack enable into $user_bin failed"
      fi
    fi

    # Last resort before the npm fallback: passwordless sudo. `-n` never
    # prompts — output is redirected to the log, so a password prompt would
    # be invisible and block until sudo times out. macOS Homebrew installs
    # land in a user-writable prefix, and a sudo retry there would create
    # root-owned shims inside /opt/homebrew that later break brew — so the
    # retry is Linux-only.
    if ! command -v pnpm >/dev/null 2>&1 && [ "$PLATFORM" = "linux" ] \
        && command -v sudo >/dev/null 2>&1; then
      log "pnpm still not on PATH — retrying corepack enable with sudo -n"
      if ! sudo -n corepack enable >> "$LOG_FILE" 2>&1; then
        log "sudo -n corepack enable failed (sudo needs a password, or corepack errored)"
      fi
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
    if ! npm install -g "pnpm@${pinned}" >> "$LOG_FILE" 2>&1; then
      # sudo can't prompt here (output goes to the log) — use a user-owned
      # prefix instead. ~/.local puts pnpm in ~/.local/bin, which nanoclaw.sh
      # and the service unit already have on PATH.
      log "npm install -g failed — retrying with a user-owned prefix"
      NPM_LOCAL_PREFIX="$HOME/.local"
      log_mark
      if ! mkdir -p "$NPM_LOCAL_PREFIX" >> "$LOG_FILE" 2>&1; then
        pnpm_why="$NPM_LOCAL_PREFIX cannot be created"
        log_error_line
        pnpm_error="$ERROR_LINE"
        pnpm_todo="Fix that, then re-run setup. mkdir's full output is in $LOG_FILE"
        log "Could not create $NPM_LOCAL_PREFIX: $pnpm_error"
      elif npm install -g "pnpm@${pinned}" --prefix "$NPM_LOCAL_PREFIX" >> "$LOG_FILE" 2>&1; then
        export PATH="$PATH:$NPM_LOCAL_PREFIX/bin"
        log "Installed pnpm@${pinned} to user-owned prefix: $NPM_LOCAL_PREFIX"
      else
        # This try needs no root, so what npm said is why pnpm is missing.
        log_error_line
        pnpm_error="$ERROR_LINE"
        if npm --version >/dev/null 2>&1; then
          pnpm_why="npm failed, also when installing into ~/.local"
          pnpm_todo="Fix that, then re-run setup. npm's full output is in $LOG_FILE"
        else
          pnpm_why="npm at $(command -v npm) cannot run"
          pnpm_todo="Reinstall Node.js to get a working npm, then re-run setup."
        fi
        log "pnpm install via user-owned prefix also failed"
      fi
    fi
  fi

  # `npm install -g` writes to npm's global prefix, which isn't always on the
  # shell PATH — common on macOS where the user has `npm config set prefix
  # ~/.npm-global` to avoid sudo, or on Linux where /usr/local/bin isn't in
  # PATH. Discover the prefix and append its bin dir so `command -v pnpm`
  # sees the new install.
  if ! command -v pnpm >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    local npm_prefix
    # Guarded: under `set -e` a failing npm would end the bootstrap right here,
    # before the lines below say why pnpm is missing.
    npm_prefix=$(npm config get prefix 2>/dev/null) || log "npm config get prefix failed"
    if [ -n "$npm_prefix" ] && [ -x "$npm_prefix/bin/pnpm" ]; then
      export PATH="$PATH:$npm_prefix/bin"
      log "Appended npm prefix bin to PATH: $npm_prefix/bin"
    fi
  fi

  if ! command -v pnpm >/dev/null 2>&1; then
    log "pnpm not on PATH after corepack + npm fallback"
    if [ -n "$pnpm_why" ]; then
      # Root is not what is missing here, and the command suggested below
      # would fail the same way. Show the real reason instead.
      echo "Could not install pnpm: $pnpm_why:"
      echo "  ${pnpm_error:-it printed nothing}"
      echo "$pnpm_todo"
      return
    fi
    if ! command -v corepack >/dev/null 2>&1 && ! command -v npm >/dev/null 2>&1; then
      echo "Could not install pnpm: there is no corepack and no npm on PATH to install it with."
      echo "Reinstall Node.js, which brings npm, then re-run setup."
      return
    fi
    # Left: npm's global install reported success, yet pnpm is nowhere this
    # script looks. The try into ~/.local was not made, so suggest it.
    echo "Could not install pnpm without root. Run this, then re-run setup:"
    echo "  npm install -g pnpm@${pinned:-<version from package.json packageManager>} --prefix ~/.local"
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

ensure_node
install_jq
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
JQ_OK: $JQ_OK
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
