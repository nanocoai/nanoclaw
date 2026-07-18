#!/usr/bin/env bash
#
# migrate-v2.sh — Migrate a NanoClaw v1 install into this v2 checkout.
#
# Run from the v2 directory:
#   bash migrate-v2.sh
#
# If you're in Claude Code, exit first or open a separate terminal.
#
# Finds v1 automatically (sibling directory, or $NANOCLAW_V1_PATH).
# Installs prerequisites (Node, pnpm, deps) via the existing setup.sh
# bootstrap, then runs the migration steps.
#
# Idempotent — safe to re-run. Use migrate-v2-reset.sh to wipe v2 state
# back to clean for development iteration.

set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

# This script has interactive prompts (channel selection, service switchover)
# and streams progress output — it must run in a real terminal, not inside
# a tool subprocess (e.g. Claude Code's Bash tool, which collapses output).
if ! [ -t 0 ] || ! [ -t 1 ]; then
  echo "This script requires an interactive terminal."
  echo ""
  echo "If you're in Claude Code, exit first or open a separate terminal,"
  echo "then run:"
  echo "  bash migrate-v2.sh"
  echo ""
  exit 1
fi

LOGS_DIR="$PROJECT_ROOT/logs"
STEPS_DIR="$LOGS_DIR/migrate-steps"
MIGRATE_LOG="$LOGS_DIR/migrate-v2.log"

# Defaults for variables that may not be set if we exit early
V1_PATH=""
V1_VERSION="unknown"
ONECLI_OK=false
SERVICE_SWITCHED=false
SELECTED_CHANNELS=()
ABORTED_AT=""

# Per-step status tracking. Parallel indexed arrays so this works on
# bash 3.2 (macOS default) which has no associative arrays.
STEP_NAMES=()
STEP_STATUSES=()

record_step() {
  STEP_NAMES+=("$1")
  STEP_STATUSES+=("$2")
}

# Write handoff.json on any exit so the skill can always read it
write_handoff() {
  local handoff_dir="$LOGS_DIR/setup-migration"
  mkdir -p "$handoff_dir"

  local has_failures=false
  local i
  for ((i=0; i<${#STEP_NAMES[@]}; i++)); do
    [ "${STEP_STATUSES[$i]}" = "failed" ] && has_failures=true
  done

  local overall="success"
  $has_failures && overall="partial"
  [ -n "$ABORTED_AT" ] && overall="failed"

  local steps_json="{"
  for ((i=0; i<${#STEP_NAMES[@]}; i++)); do
    local n="${STEP_NAMES[$i]}"
    local s="${STEP_STATUSES[$i]}"
    steps_json="${steps_json}\"${n}\": {\"status\": \"${s}\", \"log\": \"logs/migrate-steps/${n}.log\"},"
  done
  steps_json="${steps_json%,}}"

  cat > "$handoff_dir/handoff.json" <<HANDOFF_EOF
{
  "version": 1,
  "started_at": "$(ts_utc)",
  "v1_path": "$V1_PATH",
  "v1_version": "$V1_VERSION",
  "overall_status": "$overall",
  "aborted_at": "$ABORTED_AT",
  "source": "migrate-v2.sh",
  "channels_installed": [$(printf '"%s",' "${SELECTED_CHANNELS[@]}" 2>/dev/null | sed 's/,$//')],
  "onecli_healthy": $ONECLI_OK,
  "service_switched": $SERVICE_SWITCHED,
  "steps": $steps_json,
  "step_logs_dir": "logs/migrate-steps",
  "followups": [
    "Seed owner user and access policy",
    "Run /migrate-memory for staged CLAUDE.local.md files",
    "Verify container.json mount paths are valid"
  ]
}
HANDOFF_EOF
}

trap write_handoff EXIT

abort() {
  ABORTED_AT="$1"
  log "ABORTED at $1"
  exit 1
}

# ─── output helpers ──────────────────────────────────────────────────────

use_ansi() { [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; }
dim()      { use_ansi && printf '\033[2m%s\033[0m' "$1" || printf '%s' "$1"; }
green()    { use_ansi && printf '\033[32m%s\033[0m' "$1" || printf '%s' "$1"; }
red()      { use_ansi && printf '\033[31m%s\033[0m' "$1" || printf '%s' "$1"; }
bold()     { use_ansi && printf '\033[1m%s\033[0m' "$1" || printf '%s' "$1"; }
clear_line() { use_ansi && printf '\r\033[2K' || printf '\n'; }

step_ok()   { printf '%s  %s\n' "$(green '✓')" "$1"; }
step_fail() { printf '%s  %s\n' "$(red '✗')"   "$1"; }
step_skip() { printf '%s  %s\n' "$(dim '–')"   "$1"; }
step_info() { printf '%s  %s\n' "$(dim '·')"   "$1"; }

ts_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$MIGRATE_LOG"
}

# ─── init logs ───────────────────────────────────────────────────────────

mkdir -p "$STEPS_DIR"
{
  echo "## $(ts_utc) · migrate-v2.sh started"
  echo "  cwd: $PROJECT_ROOT"
  echo ""
} > "$MIGRATE_LOG"

echo
bold "NanoClaw v1 → v2 migration"
echo
echo

# ─── phase 0a: bootstrap prerequisites ──────────────────────────────────

step_info "Installing prerequisites (Node, pnpm, dependencies)…"

BOOTSTRAP_RAW="$STEPS_DIR/01-bootstrap.log"
export NANOCLAW_BOOTSTRAP_LOG="$BOOTSTRAP_RAW"

if bash "$PROJECT_ROOT/setup.sh" > "$BOOTSTRAP_RAW" 2>&1; then
  # Parse the status block from setup.sh output
  STATUS=$(grep '^STATUS:' "$BOOTSTRAP_RAW" | head -1 | sed 's/^STATUS: *//')
  NODE_VERSION=$(grep '^NODE_VERSION:' "$BOOTSTRAP_RAW" | head -1 | sed 's/^NODE_VERSION: *//')

  if [ "$STATUS" = "success" ]; then
    step_ok "Prerequisites ready $(dim "(node $NODE_VERSION)")"
    log "Bootstrap succeeded: node=$NODE_VERSION"
  else
    step_fail "Bootstrap reported: $STATUS"
    echo
    dim "  See: $BOOTSTRAP_RAW"
    echo
    abort "bootstrap"
  fi
else
  step_fail "Bootstrap failed"
  echo
  echo "$(dim '── last 20 lines ──')"
  tail -20 "$BOOTSTRAP_RAW" 2>/dev/null || true
  echo
  dim "  Full log: $BOOTSTRAP_RAW"
  echo
  abort "bootstrap"
fi

# setup.sh may have installed pnpm to a prefix not on our PATH — replay
# the same lookup nanoclaw.sh does.
if ! command -v pnpm >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  NPM_PREFIX="$(npm config get prefix 2>/dev/null)"
  if [ -n "$NPM_PREFIX" ] && [ -x "$NPM_PREFIX/bin/pnpm" ]; then
    export PATH="$NPM_PREFIX/bin:$PATH"
  fi
fi

if ! command -v pnpm >/dev/null 2>&1; then
  step_fail "pnpm not found after bootstrap"
  abort "pnpm-missing"
fi

# ─── phase 0b: find v1 install ──────────────────────────────────────────

find_v1() {
  # Explicit override
  if [ -n "${NANOCLAW_V1_PATH:-}" ]; then
    if [ -f "$NANOCLAW_V1_PATH/store/messages.db" ]; then
      echo "$NANOCLAW_V1_PATH"
      return 0
    fi
    step_fail "NANOCLAW_V1_PATH=$NANOCLAW_V1_PATH does not contain store/messages.db"
    return 1
  fi

  # Scan sibling directories for anything claw-ish with a v1 DB
  local parent
  parent="$(dirname "$PROJECT_ROOT")"
  for entry in "$parent"/*/; do
    [ -d "$entry" ] || continue
    # Skip ourselves
    [ "$(cd "$entry" && pwd)" = "$PROJECT_ROOT" ] && continue
    # Must have the v1 DB
    [ -f "$entry/store/messages.db" ] || continue
    # Must not be v2 (check package.json version)
    if [ -f "$entry/package.json" ]; then
      local ver
      ver=$(grep '"version"' "$entry/package.json" 2>/dev/null | head -1 | sed -E 's/.*"([0-9]+)\..*/\1/')
      [ "$ver" = "2" ] && continue
    fi
    echo "$(cd "$entry" && pwd)"
    return 0
  done

  return 1
}

V1_PATH=""
if V1_PATH=$(find_v1); then
  V1_VERSION=$(grep '"version"' "$V1_PATH/package.json" 2>/dev/null | head -1 | sed -E 's/.*"([^"]+)".*/\1/' || echo "unknown")
  step_ok "Found v1 at $(dim "$V1_PATH") $(dim "(v$V1_VERSION)")"
  log "v1 found: $V1_PATH (v$V1_VERSION)"
else
  step_fail "No v1 install found"
  echo
  echo "  $(dim 'Set NANOCLAW_V1_PATH to point at your v1 checkout:')"
  echo "  $(dim 'NANOCLAW_V1_PATH=~/nanoclaw bash migrate-v2.sh')"
  echo
  abort "v1-not-found"
fi

# ─── phase 0c: validate v1 DB ───────────────────────────────────────────

V1_DB="$V1_PATH/store/messages.db"

# Quick schema check — make sure the tables we need exist.
# Uses the in-tree wrapper instead of the sqlite3 CLI: setup.sh (run via
# phase 0a above) installs Node + better-sqlite3 but NOT the sqlite3 CLI,
# and #2191 documented how a missing CLI here used to surface as a
# misleading "registered_groups missing" abort.
TABLES=$(pnpm exec tsx scripts/q.ts "$V1_DB" "SELECT name FROM sqlite_master WHERE type='table'" 2>/dev/null || true)

if echo "$TABLES" | grep -q "registered_groups"; then
  step_ok "v1 database has registered_groups"
else
  step_fail "v1 database missing registered_groups table"
  abort "v1-db-invalid"
fi

# Show what we found
GROUP_COUNT=$(pnpm exec tsx scripts/q.ts "$V1_DB" "SELECT COUNT(*) FROM registered_groups" 2>/dev/null || echo 0)
TASK_COUNT=$(pnpm exec tsx scripts/q.ts "$V1_DB" "SELECT COUNT(*) FROM scheduled_tasks WHERE status='active'" 2>/dev/null || echo 0)
ENV_KEYS=0
if [ -f "$V1_PATH/.env" ]; then
  ENV_KEYS=$(grep -c '=' "$V1_PATH/.env" 2>/dev/null || echo 0)
fi

step_info "v1 state: $(bold "$GROUP_COUNT") groups, $(bold "$TASK_COUNT") active tasks, $(bold "$ENV_KEYS") env keys"

echo
step_ok "Phase 0 complete — ready to migrate"
echo
log "Phase 0 complete: groups=$GROUP_COUNT tasks=$TASK_COUNT env_keys=$ENV_KEYS"

export NANOCLAW_V1_PATH="$V1_PATH"
export NANOCLAW_V2_PATH="$PROJECT_ROOT"

# ─── run_step helper ─────────────────────────────────────────────────────
# Runs a TypeScript migration step, captures output, reports success/failure.

# Step outcomes are tracked via record_step() into STEP_NAMES/STEP_STATUSES
# (defined above, near write_handoff).

run_step() {
  local name=$1 label=$2 script=$3
  shift 3
  local raw="$STEPS_DIR/${name}.log"

  if pnpm exec tsx "$script" "$@" > "$raw" 2>&1; then
    local result
    result=$(grep '^OK:' "$raw" | head -1 || true)
    step_ok "$label $(dim "$result")"
    log "$name: $result"
    record_step "$name" "success"
    # Surface partial errors (rows skipped due to parse/lookup failures)
    # even when the step exited successfully — they're easy to miss in the
    # raw log and have caused silent migrations before.
    if grep -q '^ERROR:' "$raw" 2>/dev/null; then
      local err_count
      err_count=$(grep -c '^ERROR:' "$raw")
      echo "  $(dim "${err_count} error(s) reported — see $raw")"
      grep '^ERROR:' "$raw" | head -3 | while IFS= read -r line; do
        echo "  $(dim "$line")"
      done
      log "$name: ${err_count} non-fatal errors"
    fi
  elif grep -q '^SKIPPED:' "$raw" 2>/dev/null; then
    local reason
    reason=$(grep '^SKIPPED:' "$raw" | head -1 | sed 's/^SKIPPED://')
    step_skip "$label $(dim "($reason)")"
    log "$name: skipped ($reason)"
    record_step "$name" "skipped"
  else
    step_fail "$label"
    echo
    tail -10 "$raw" 2>/dev/null | while IFS= read -r line; do
      echo "  $(dim "$line")"
    done
    echo
    log "$name: FAILED (see $raw)"
    record_step "$name" "failed"
  fi
}

# ─── phase 1: core state ────────────────────────────────────────────────

echo "$(bold 'Phase 1: Core state')"
echo

run_step "1a-env" \
  "Merge .env" \
  "setup/migrate-v2/env.ts" "$V1_PATH"

run_step "1b-db" \
  "Seed v2 database" \
  "setup/migrate-v2/db.ts" "$V1_PATH"

run_step "1c-groups" \
  "Copy group folders" \
  "setup/migrate-v2/groups.ts" "$V1_PATH"

run_step "1d-sessions" \
  "Copy session data" \
  "setup/migrate-v2/sessions.ts" "$V1_PATH"

run_step "1e-tasks" \
  "Port scheduled tasks" \
  "setup/migrate-v2/tasks.ts" "$V1_PATH"

echo
step_ok "Phase 1 complete"
echo

# ─── phase 2: channels (interactive) ────────────────────────────────────

echo "$(bold 'Phase 2: Channels')"
echo

# Channel selection — clack multiselect (interactive) or NANOCLAW_CHANNELS env var.
# NANOCLAW_CHANNELS accepts comma-separated channel names: "telegram,discord"
SELECTED_CHANNELS=()
CHANNEL_SELECT_OUT="$STEPS_DIR/2a-channels-selected.txt"

pnpm exec tsx setup/migrate-v2/select-channels.ts "$CHANNEL_SELECT_OUT" || true

if [ -f "$CHANNEL_SELECT_OUT" ]; then
  while IFS= read -r ch; do
    [ -n "$ch" ] && SELECTED_CHANNELS+=("$ch")
  done < "$CHANNEL_SELECT_OUT"
fi

if [ ${#SELECTED_CHANNELS[@]} -eq 0 ]; then
  echo
  step_skip "No channels selected"
else
  echo
  step_info "Selected: ${SELECTED_CHANNELS[*]}"
  echo

  # 2b. Copy channel auth state
  run_step "2b-channel-auth" \
    "Copy channel credentials" \
    "setup/migrate-v2/channel-auth.ts" "$V1_PATH" "${SELECTED_CHANNELS[@]}"

  # 2c. Install channel code
  for ch in "${SELECTED_CHANNELS[@]}"; do
    INSTALL_SCRIPT="setup/install-${ch}.sh"
    STEP_NAME="2c-install-${ch}"
    if [ -f "$INSTALL_SCRIPT" ]; then
      STEP_LOG="$STEPS_DIR/${STEP_NAME}.log"
      if bash "$INSTALL_SCRIPT" > "$STEP_LOG" 2>&1; then
        STATUS_LINE=$(grep '^STATUS:' "$STEP_LOG" | head -1 | sed 's/^STATUS: *//')
        if [ "$STATUS_LINE" = "already-installed" ]; then
          step_skip "Install $ch $(dim "(already installed)")"
          record_step "$STEP_NAME" "skipped"
        else
          step_ok "Install $ch"
          record_step "$STEP_NAME" "success"
        fi
        log "install-$ch: $STATUS_LINE"
      else
        step_fail "Install $ch"
        tail -5 "$STEP_LOG" 2>/dev/null | while IFS= read -r line; do
          echo "  $(dim "$line")"
        done
        log "install-$ch: FAILED (see $STEP_LOG)"
        record_step "$STEP_NAME" "failed"
      fi
    else
      step_skip "Install $ch $(dim "(no install script)")"
      log "install-$ch: no install script"
      record_step "$STEP_NAME" "failed"
    fi
  done

  # 2d. (Removed) WhatsApp LID resolution was previously needed because the
  # v6 adapter couldn't reliably translate LID→phone JIDs, so the migration
  # pre-created dual messaging_groups rows. With Baileys v7, the adapter
  # resolves LIDs via extractAddressingContext + signalRepository.lidMapping
  # on every inbound message, so dual rows are unnecessary and were causing
  # split sessions.
fi

echo
step_ok "Phase 2 complete"
echo

# ─── phase 3: infrastructure ────────────────────────────────────────────

echo "$(bold 'Phase 3: Infrastructure')"
echo

# 3a. Docker — install if missing (OneCLI needs it)
if command -v docker >/dev/null 2>&1; then
  DOCKER_V=$(docker --version 2>/dev/null | head -1)
  step_ok "Docker available $(dim "($DOCKER_V)")"
  log "Docker: $DOCKER_V"
else
  step_info "Installing Docker…"
  DOCKER_LOG="$STEPS_DIR/3a-docker.log"
  if bash setup/install-docker.sh > "$DOCKER_LOG" 2>&1; then
    hash -r 2>/dev/null || true
    step_ok "Docker installed"
    record_step "3a-docker" "success"
    log "Docker: installed"
  else
    step_fail "Docker install failed $(dim "(see $DOCKER_LOG)")"
    record_step "3a-docker" "failed"
    log "Docker: FAILED"
  fi
fi

# 3b. OneCLI — detect or install via setup step (requires Docker)
ONECLI_OK=false
ONECLI_URL_FROM_ENV=$(grep '^ONECLI_URL=' .env 2>/dev/null | head -1 | sed 's/^ONECLI_URL=//')
ONECLI_URL_CHECK="${ONECLI_URL_FROM_ENV:-http://127.0.0.1:10254}"

if curl -sf "${ONECLI_URL_CHECK}/api/health" >/dev/null 2>&1; then
  step_ok "OneCLI running at $(dim "$ONECLI_URL_CHECK")"
  ONECLI_OK=true
  log "OneCLI: running at $ONECLI_URL_CHECK"
elif command -v docker >/dev/null 2>&1; then
  step_info "Setting up OneCLI…"
  ONECLI_LOG="$STEPS_DIR/3b-onecli.log"
  ONECLI_ERR="$STEPS_DIR/3b-onecli.err"
  if pnpm exec tsx setup/index.ts --step onecli > "$ONECLI_LOG" 2>"$ONECLI_ERR"; then
    step_ok "OneCLI ready"
    ONECLI_OK=true
    record_step "3b-onecli" "success"
    log "OneCLI: installed/configured"
  else
    step_fail "OneCLI setup failed $(dim "(see $ONECLI_LOG)")"
    record_step "3b-onecli" "failed"
    log "OneCLI: FAILED"
  fi
else
  step_fail "OneCLI needs Docker $(dim "(install Docker first)")"
  record_step "3b-onecli" "failed"
  log "OneCLI: skipped (no Docker)"
fi

# 3c. Anthropic credential — run the auth setup step if no credential found
if grep -qE '^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=' .env 2>/dev/null; then
  step_ok "Anthropic credential found in .env"
  log "Anthropic credential: found in .env"
elif [ "$ONECLI_OK" = "true" ]; then
  step_info "Registering Anthropic credential…"
  AUTH_LOG="$STEPS_DIR/3c-auth.log"
  AUTH_ERR="$STEPS_DIR/3c-auth.err"
  if pnpm exec tsx setup/index.ts --step auth > "$AUTH_LOG" 2>"$AUTH_ERR"; then
    step_ok "Anthropic credential registered"
    record_step "3c-auth" "success"
    log "Anthropic credential: registered via auth step"
  else
    step_fail "Auth setup failed $(dim "(see $AUTH_LOG)")"
    record_step "3c-auth" "failed"
    log "Anthropic credential: FAILED"
  fi
else
  step_info "No Anthropic credential $(dim "(OneCLI not available — add manually to .env)")"
  log "Anthropic credential: skipped (no OneCLI)"
fi

# 3d. Copy container skills from v1 that v2 doesn't have
V1_SKILLS_DIR="$V1_PATH/container/skills"
V2_SKILLS_DIR="$PROJECT_ROOT/container/skills"

if [ -d "$V1_SKILLS_DIR" ]; then
  SKILLS_COPIED=0
  SKILLS_SKIPPED=0
  for skill_dir in "$V1_SKILLS_DIR"/*/; do
    [ -d "$skill_dir" ] || continue
    skill_name=$(basename "$skill_dir")
    if [ -d "$V2_SKILLS_DIR/$skill_name" ]; then
      SKILLS_SKIPPED=$((SKILLS_SKIPPED + 1))
    else
      cp -r "$skill_dir" "$V2_SKILLS_DIR/$skill_name"
      SKILLS_COPIED=$((SKILLS_COPIED + 1))
    fi
  done
  if [ $SKILLS_COPIED -gt 0 ]; then
    step_ok "Copied $SKILLS_COPIED container skills $(dim "(skipped $SKILLS_SKIPPED already in v2)")"
  else
    step_skip "All v1 container skills already in v2 $(dim "($SKILLS_SKIPPED)")"
  fi
  log "Container skills: copied=$SKILLS_COPIED skipped=$SKILLS_SKIPPED"
else
  step_skip "No v1 container skills"
fi

# 3e. Build agent container image
if command -v docker >/dev/null 2>&1; then
  step_info "Building agent container image…"
  BUILD_LOG="$STEPS_DIR/3e-container-build.log"
  if bash container/build.sh > "$BUILD_LOG" 2>&1; then
    step_ok "Container image built"
    record_step "3e-build" "success"
    log "Container build: success"
  else
    step_fail "Container build failed"
    record_step "3e-build" "failed"
    tail -10 "$BUILD_LOG" 2>/dev/null | while IFS= read -r line; do
      echo "  $(dim "$line")"
    done
    log "Container build: FAILED (see $BUILD_LOG)"
  fi
else
  step_fail "Docker not available — cannot build container"
  record_step "3e-build" "failed"
  log "Container build: skipped (no Docker)"
fi

echo
step_ok "Phase 3 complete"
echo

# ─── service switchover ─────────────────────────────────────────────────

echo "$(bold 'Service switchover')"
echo

# Disable the v1 service so it doesn't auto-start, but leave the unit file
# on disk so the user can rollback with: systemctl --user start nanoclaw
# Idempotent — safe to call multiple times.
disable_v1_service() {
  if [ "$PLATFORM_SERVICE" = "systemd" ]; then
    local v1_file="$HOME/.config/systemd/user/${V1_SERVICE}.service"
    if [ -f "$v1_file" ] || [ -L "$v1_file" ]; then
      systemctl --user stop "$V1_SERVICE" 2>/dev/null || true
      systemctl --user disable "$V1_SERVICE" 2>/dev/null || true
      step_ok "Disabled $V1_SERVICE (unit file kept for rollback)"
    fi
  elif [ "$PLATFORM_SERVICE" = "launchd" ]; then
    local v1_plist="$HOME/Library/LaunchAgents/${V1_SERVICE}.plist"
    if [ -f "$v1_plist" ] || [ -L "$v1_plist" ]; then
      launchctl unload "$v1_plist" 2>/dev/null || true
      step_ok "Unloaded $V1_SERVICE (plist kept for rollback)"
    fi
  fi
}

# Detect platform and service names
V1_SERVICE=""
V2_SERVICE=""
PLATFORM_SERVICE=""

if [ "$(uname -s)" = "Darwin" ]; then
  PLATFORM_SERVICE="launchd"
  V1_SERVICE="com.nanoclaw"
  # v2 uses install-slug for unique service names
  V2_SERVICE=$(pnpm exec tsx -e "import{getLaunchdLabel}from'./src/install-slug.js';console.log(getLaunchdLabel())" 2>/dev/null || echo "")
elif [ "$(uname -s)" = "Linux" ]; then
  PLATFORM_SERVICE="systemd"
  V1_SERVICE="nanoclaw"
  V2_SERVICE=$(pnpm exec tsx -e "import{getSystemdUnit}from'./src/install-slug.js';console.log(getSystemdUnit())" 2>/dev/null || echo "")
fi

# Check if v1 service is running
V1_RUNNING=false
if [ "$PLATFORM_SERVICE" = "systemd" ]; then
  systemctl --user is-active "$V1_SERVICE" >/dev/null 2>&1 && V1_RUNNING=true
elif [ "$PLATFORM_SERVICE" = "launchd" ]; then
  launchctl list "$V1_SERVICE" >/dev/null 2>&1 && V1_RUNNING=true
fi

SERVICE_SWITCHED=false
if [ "$V1_RUNNING" = "true" ]; then
  step_info "v1 service is running $(dim "($V1_SERVICE)")"

  # Ask user if they want to switch
  SWITCH_ANSWER_FILE=$(mktemp)
  pnpm exec tsx setup/migrate-v2/switchover-prompt.ts --offer-switch "$SWITCH_ANSWER_FILE" || true
  SWITCH_ANSWER=$(cat "$SWITCH_ANSWER_FILE" 2>/dev/null || echo "skip")
  rm -f "$SWITCH_ANSWER_FILE"

  if [ "$SWITCH_ANSWER" = "switch" ]; then
    # Stop v1
    if [ "$PLATFORM_SERVICE" = "systemd" ]; then
      systemctl --user stop "$V1_SERVICE" 2>/dev/null && step_ok "Stopped v1 service" || step_fail "Could not stop v1"
    elif [ "$PLATFORM_SERVICE" = "launchd" ]; then
      launchctl unload ~/Library/LaunchAgents/${V1_SERVICE}.plist 2>/dev/null && step_ok "Stopped v1 service" || step_fail "Could not stop v1"
    fi

    # Install and start v2 service
    V2_SERVICE_LOG="$STEPS_DIR/service-install.log"
    V2_SERVICE_ERR="$STEPS_DIR/service-install.err"
    if pnpm exec tsx setup/index.ts --step service > "$V2_SERVICE_LOG" 2>"$V2_SERVICE_ERR"; then
      # Parse the actual unit name from the service step stdout (clean, no ANSI)
      if [ "$PLATFORM_SERVICE" = "systemd" ]; then
        V2_SERVICE=$(grep '^SERVICE_UNIT:' "$V2_SERVICE_LOG" | head -1 | sed 's/^SERVICE_UNIT: *//')
      elif [ "$PLATFORM_SERVICE" = "launchd" ]; then
        V2_SERVICE=$(grep '^SERVICE_LABEL:' "$V2_SERVICE_LOG" | head -1 | sed 's/^SERVICE_LABEL: *//')
      fi
      step_ok "v2 service installed and started $(dim "($V2_SERVICE)")"
    else
      step_fail "Could not start v2 service $(dim "(see $V2_SERVICE_LOG)")"
    fi

    SERVICE_SWITCHED=true
    echo
    step_info "v2 is running — send a test message to your bot"
    echo

    # Ask: keep or revert?
    KEEP_ANSWER_FILE=$(mktemp)
    pnpm exec tsx setup/migrate-v2/switchover-prompt.ts --keep-or-revert "$KEEP_ANSWER_FILE" || true
    KEEP_ANSWER=$(cat "$KEEP_ANSWER_FILE" 2>/dev/null || echo "keep")
    rm -f "$KEEP_ANSWER_FILE"

    if [ "$KEEP_ANSWER" = "revert" ]; then
      # Stop v2
      if [ "$PLATFORM_SERVICE" = "systemd" ] && [ -n "$V2_SERVICE" ]; then
        systemctl --user stop "$V2_SERVICE" 2>/dev/null || true
        systemctl --user disable "$V2_SERVICE" 2>/dev/null || true
      elif [ "$PLATFORM_SERVICE" = "launchd" ] && [ -n "$V2_SERVICE" ]; then
        launchctl unload ~/Library/LaunchAgents/${V2_SERVICE}.plist 2>/dev/null || true
      fi

      # Restart v1
      if [ "$PLATFORM_SERVICE" = "systemd" ]; then
        systemctl --user start "$V1_SERVICE" 2>/dev/null || true
      elif [ "$PLATFORM_SERVICE" = "launchd" ]; then
        launchctl load ~/Library/LaunchAgents/${V1_SERVICE}.plist 2>/dev/null || true
      fi

      step_ok "Reverted to v1 service"
      SERVICE_SWITCHED=false
    else
      step_ok "Keeping v2 service"
      disable_v1_service
    fi
  else
    step_skip "Service switchover skipped"
  fi
else
  step_skip "v1 service not running — nothing to switch"
  disable_v1_service
fi

echo

# ─── phase 4: handoff ───────────────────────────────────────────────────
# handoff.json is written by the EXIT trap (write_handoff) — always, even on
# abort. Here we just print the summary.

echo "$(bold 'Phase 4: Handoff')"
echo

step_ok "Wrote handoff summary"

# Summary
echo
echo "$(bold '── Migration complete ──')"
echo
echo "  $(dim 'v1:')  $V1_PATH"
echo "  $(dim 'v2:')  $PROJECT_ROOT"
echo
echo "  $(bold 'What was done:')"
echo "    $(green '✓')  .env keys merged"
echo "    $(green '✓')  Database seeded (agent groups, messaging groups, wiring)"
echo "    $(green '✓')  Group folders copied (CLAUDE.md staged for /migrate-memory)"
echo "    $(green '✓')  Session data copied"
echo "    $(green '✓')  Scheduled tasks ported"
if [ ${#SELECTED_CHANNELS[@]} -gt 0 ]; then
echo "    $(green '✓')  Channels installed: ${SELECTED_CHANNELS[*]}"
fi
echo "    $(green '✓')  Container skills copied"
echo "    $(green '✓')  Container image built"
if [ "$SERVICE_SWITCHED" = "true" ] && [ -n "$V2_SERVICE" ]; then
echo "    $(green '✓')  Service switched to v2 $(dim "($V2_SERVICE)")"
echo
echo "  $(bold 'Rollback to v1:')"
if [ "$PLATFORM_SERVICE" = "systemd" ]; then
echo "    $(dim '$') systemctl --user stop $V2_SERVICE && systemctl --user start $V1_SERVICE"
elif [ "$PLATFORM_SERVICE" = "launchd" ]; then
echo "    $(dim '$') launchctl unload ~/Library/LaunchAgents/${V2_SERVICE}.plist && launchctl load ~/Library/LaunchAgents/${V1_SERVICE}.plist"
fi
fi
echo
echo "  $(bold 'What still needs a human:')"
if [ "$ONECLI_OK" = "false" ]; then
echo "    $(dim '·')  Set up OneCLI: pnpm exec tsx setup/index.ts --step onecli"
fi
if ! grep -qE '^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=' .env 2>/dev/null; then
echo "    $(dim '·')  Add Anthropic credential to .env or OneCLI vault"
fi
echo "    $(dim '·')  Run $(bold '/migrate-from-v1') in Claude to finish:"
echo "       $(dim '- Seed your owner account')"
echo "       $(dim '- Set access policies')"
echo "       $(dim '- Port any custom v1 code')"
echo
echo "  $(dim "Handoff: $LOGS_DIR/setup-migration/handoff.json")"
echo "  $(dim "Full log: $MIGRATE_LOG")"
echo "  $(dim "Step logs: $STEPS_DIR/")"
echo

# ─── hand off to Claude ─────────────────────────────────────────────────

if command -v claude >/dev/null 2>&1; then
  write_handoff
  trap - EXIT
  exec claude "/migrate-from-v1"
fi
