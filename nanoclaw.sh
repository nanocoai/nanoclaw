#!/usr/bin/env bash
#
# NanoClaw — end-to-end setup entry point.
#
# Runs two parts from the user's perspective as one continuous flow:
#   - bash-side: install the basics (Node + pnpm + native modules) under a
#     bash-rendered clack-alike spinner. Can't use setup/auto.ts here since
#     tsx isn't available until pnpm install completes.
#   - hand off to `pnpm run setup:auto`, which renders the rest with
#     @clack/prompts. The wordmark is printed once here so setup:auto can
#     skip it and the flow reads as a single sequence.
#
# Obeys the three-level output contract (see docs/setup-flow.md):
#   1. User-facing       — concise status line with elapsed time
#   2. Progression log   — logs/setup.log (header + one entry per step)
#   3. Raw per-step log  — logs/setup-steps/NN-name.log (full verbatim output)
#
# Config via env — passed through unchanged:
#   NANOCLAW_SKIP  comma-separated setup:auto step names to skip
#   SECRET_NAME    OneCLI secret name (default: Anthropic)
#   HOST_PATTERN   OneCLI host pattern (default: api.anthropic.com)

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

# --catalog-preseeds is a read-only build-time contract. Never bootstrap or
# create setup state just to inspect it.
for arg in "$@"; do
  if [ "$arg" = "--catalog-preseeds" ]; then
    if [ "$#" -ne 1 ]; then
      echo "--catalog-preseeds does not accept other arguments" >&2
      exit 2
    fi
    if ! command -v node >/dev/null 2>&1 || [ ! -x "$PROJECT_ROOT/node_modules/.bin/tsx" ]; then
      echo "Cannot print the preseed catalog: run pnpm install first." >&2
      exit 1
    fi
    exec "$PROJECT_ROOT/node_modules/.bin/tsx" "$PROJECT_ROOT/setup/catalog-preseeds.ts"
  fi
done

# ─── --slack-agents: former testing flag, accepted and ignored ─────────
# The managed Slack experience is simply the default; the flag that once
# enabled it is swallowed so older invocations keep working.
_filtered_args=()
for arg in "$@"; do
  if [ "$arg" = "--slack-agents" ]; then
    :
  else
    _filtered_args+=("$arg")
  fi
done
set -- ${_filtered_args[@]+"${_filtered_args[@]}"}
unset _filtered_args

# Parse the opt-in machine protocol before any output or mutation.
DRIVER_MODE=false
DRIVER_OPERATION=setup
DRIVER_PROTOCOL=""
DRIVER_PROTOCOL_COUNT=0
DRIVER_EXPECT_PROTOCOL=false
for arg in "$@"; do
  if [ "$DRIVER_EXPECT_PROTOCOL" = true ]; then
    DRIVER_PROTOCOL="$arg"
    DRIVER_EXPECT_PROTOCOL=false
    continue
  fi
  case "$arg" in
    --protocol) DRIVER_PROTOCOL_COUNT=$((DRIVER_PROTOCOL_COUNT + 1)); DRIVER_EXPECT_PROTOCOL=true ;;
    --protocol=*) DRIVER_PROTOCOL_COUNT=$((DRIVER_PROTOCOL_COUNT + 1)); DRIVER_PROTOCOL="${arg#--protocol=}" ;;
    --uninstall) DRIVER_OPERATION=uninstall ;;
  esac
done

if [ "$DRIVER_EXPECT_PROTOCOL" = true ]; then
  echo "error: --protocol requires a value" >&2
  exit 1
fi
if [ -n "$DRIVER_PROTOCOL" ] && [ "$DRIVER_PROTOCOL" != "nanoclaw.driver.v1" ]; then
  echo "error: unsupported protocol '$DRIVER_PROTOCOL'" >&2
  exit 1
fi
if [ "$DRIVER_PROTOCOL_COUNT" -gt 1 ]; then
  if [ "$DRIVER_PROTOCOL" = "nanoclaw.driver.v1" ]; then
    printf '{"protocol":"nanoclaw.driver.v1","operation":"%s","type":"hello"}\n' "$DRIVER_OPERATION"
    printf '{"protocol":"nanoclaw.driver.v1","operation":"%s","type":"error","code":"duplicate_protocol","message":"--protocol may be supplied only once.","recovery":[]}\n' "$DRIVER_OPERATION"
  else
    echo "error: --protocol may be supplied only once" >&2
  fi
  exit 1
fi

DRIVER_ARGS=()
DRIVER_ACKS=""
if [ "$DRIVER_PROTOCOL" = "nanoclaw.driver.v1" ]; then
  DRIVER_MODE=true
  DRIVER_SKIP_NEXT=""
  for arg in "$@"; do
    if [ "$DRIVER_SKIP_NEXT" = protocol ]; then DRIVER_SKIP_NEXT=""; continue; fi
    if [ "$DRIVER_SKIP_NEXT" = ack ]; then
      case "$arg" in low-memory|gce|root) ;; *)
        printf '{"protocol":"nanoclaw.driver.v1","operation":"%s","type":"hello"}\n' "$DRIVER_OPERATION"
        printf '{"protocol":"nanoclaw.driver.v1","operation":"%s","type":"error","code":"invalid_driver_ack","message":"Unknown driver acknowledgement.","recovery":[]}\n' "$DRIVER_OPERATION"
        exit 1
      esac
      DRIVER_ACKS="${DRIVER_ACKS:+${DRIVER_ACKS},}${arg}"
      DRIVER_SKIP_NEXT=""
      continue
    fi
    case "$arg" in
      --protocol) DRIVER_SKIP_NEXT=protocol ;;
      --protocol=*) ;;
      --driver-ack) DRIVER_SKIP_NEXT=ack ;;
      --driver-ack=*)
        ack="${arg#--driver-ack=}"
        case "$ack" in low-memory|gce|root) DRIVER_ACKS="${DRIVER_ACKS:+${DRIVER_ACKS},}${ack}" ;; *)
          printf '{"protocol":"nanoclaw.driver.v1","operation":"%s","type":"hello"}\n' "$DRIVER_OPERATION"
          printf '{"protocol":"nanoclaw.driver.v1","operation":"%s","type":"error","code":"invalid_driver_ack","message":"Unknown driver acknowledgement.","recovery":[]}\n' "$DRIVER_OPERATION"
          exit 1
        esac
        ;;
      --onecli-api-token|--anthropic-auth-token|--onecli-api-token=*|--anthropic-auth-token=*)
        printf '{"protocol":"nanoclaw.driver.v1","operation":"%s","type":"hello"}\n' "$DRIVER_OPERATION"
        printf '{"protocol":"nanoclaw.driver.v1","operation":"%s","type":"error","code":"secret_transport_forbidden","message":"Secret answers must arrive through protocol stdin, not driver arguments.","recovery":[]}\n' "$DRIVER_OPERATION"
        exit 1
        ;;
      *) DRIVER_ARGS+=("$arg") ;;
    esac
  done
  if [ "$DRIVER_SKIP_NEXT" = ack ]; then
    printf '{"protocol":"nanoclaw.driver.v1","operation":"%s","type":"hello"}\n' "$DRIVER_OPERATION"
    printf '{"protocol":"nanoclaw.driver.v1","operation":"%s","type":"error","code":"invalid_driver_ack","message":"--driver-ack requires a value.","recovery":[]}\n' "$DRIVER_OPERATION"
    exit 1
  fi
  printf '{"protocol":"nanoclaw.driver.v1","operation":"%s","type":"hello"}\n' "$DRIVER_OPERATION"
  for arg in ${DRIVER_ARGS[@]+"${DRIVER_ARGS[@]}"}; do
    if [[ "$arg" =~ [[:cntrl:]] ]]; then
      printf '{"protocol":"nanoclaw.driver.v1","operation":"%s","type":"error","code":"invalid_arguments","message":"Driver arguments may not contain control characters.","recovery":[]}\n' "$DRIVER_OPERATION"
      exit 1
    fi
  done
  if [ -n "${NANOCLAW_ONECLI_API_TOKEN:-}" ] || [ -n "${NANOCLAW_ANTHROPIC_AUTH_TOKEN:-}" ] || [ -n "${NANOCLAW_REGISTRY_ENROLL_CODE:-}" ] || [ -n "${NANOCLAW_REGISTRY_TOKEN:-}" ]; then
    printf '{"protocol":"nanoclaw.driver.v1","operation":"%s","type":"error","code":"secret_transport_forbidden","message":"Secret answers must arrive through protocol stdin, not the launch environment.","recovery":[]}\n' "$DRIVER_OPERATION"
    exit 1
  fi
  set -- ${DRIVER_ARGS[@]+"${DRIVER_ARGS[@]}"}
fi

driver_has_ack() { case ",$DRIVER_ACKS," in *,$1,*) return 0 ;; *) return 1 ;; esac; }
driver_json_string() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '"%s"' "$value"
}
driver_recovery_args() {
  local ack="$1"
  shift
  printf '["--protocol","nanoclaw.driver.v1"'
  for arg in "$@"; do printf ',%s' "$(driver_json_string "$arg")"; done
  for known in low-memory gce root; do
    if driver_has_ack "$known"; then printf ',"--driver-ack","%s"' "$known"; fi
  done
  printf ',"--driver-ack","%s"]' "$ack"
}

# ─── --help: show usage without bootstrapping ──────────────────────────
for arg in "$@"; do
  if [ "$arg" = "--help" ] || [ "$arg" = "-h" ]; then
    if [ "$DRIVER_MODE" = true ]; then
      printf '{"protocol":"nanoclaw.driver.v1","operation":"%s","type":"error","code":"help_requested","message":"Machine mode does not render terminal help.","recovery":[{"kind":"rerun","args":["--help"]}]}\n' "$DRIVER_OPERATION"
      exit 1
    fi
    if command -v node >/dev/null 2>&1 && [ -x "$PROJECT_ROOT/node_modules/.bin/tsx" ]; then
      exec "$PROJECT_ROOT/node_modules/.bin/tsx" "$PROJECT_ROOT/setup/auto.ts" "$@"
    fi
    echo "Usage: bash nanoclaw.sh [options]"
    echo ""
    echo "  --catalog-preseeds    Print the build-time preseed contract as JSON"
    echo "  --template-path <ref>  Create or update an agent from templates/<ref>"
    echo "  --uninstall            Uninstall this NanoClaw copy"
    echo "  --help, -h             Show this help without installing dependencies"
    exit 0
  fi
done

# ─── --uninstall: short-circuit before any setup work ──────────────────
# Never install dependencies just to uninstall. With the TS toolchain
# present, hand straight off to setup:auto (the flow lives in
# setup/uninstall/); without it, print manual cleanup guidance. Runs
# before diagnostics.sh is sourced so a pure uninstall doesn't emit
# setup_launched, and before all pre-flights/bootstrap.
for arg in "$@"; do
  if [ "$arg" = "--uninstall" ]; then
    # exec tsx directly rather than `pnpm run -- …`: pnpm passes the `--`
    # separator through to the script, where the flag parser treats
    # everything after it as positional args and the flags get dropped.
    # Gate on node (tsx's shebang interpreter) — pnpm isn't used here.
    if command -v node >/dev/null 2>&1 && [ -x "$PROJECT_ROOT/node_modules/.bin/tsx" ]; then
      if [ "$DRIVER_MODE" = true ]; then
        export NANOCLAW_PROTOCOL=nanoclaw.driver.v1
        export NANOCLAW_OPERATION=uninstall
        export NANOCLAW_DRIVER_SHELL_HELLO=1
      fi
      exec "$PROJECT_ROOT/node_modules/.bin/tsx" "$PROJECT_ROOT/setup/auto.ts" "$@"
    fi
    if [ "$DRIVER_MODE" = true ]; then
      printf '{"protocol":"nanoclaw.driver.v1","operation":"uninstall","type":"error","code":"runtime_missing","message":"The TypeScript runtime is unavailable; uninstall left everything untouched.","recovery":[{"kind":"manual","title":"Restore the runtime","instructions":["Run bash nanoclaw.sh once without uninstall, then retry."]}]}\n'
      exit 1
    fi
    export NANOCLAW_PROJECT_ROOT="$PROJECT_ROOT"
    # shellcheck source=setup/lib/install-slug.sh
    source "$PROJECT_ROOT/setup/lib/install-slug.sh"
    UNINSTALL_RUNTIME="${CONTAINER_RUNTIME:-docker}"
    echo "Can't run the uninstaller: dependencies are missing (node_modules/)."
    echo "Either re-run 'bash nanoclaw.sh' once to restore them, or clean up manually:"
    echo ""
    if [ "$(uname -s)" = "Darwin" ]; then
      echo "  launchctl unload ~/Library/LaunchAgents/$(launchd_label).plist"
      echo "  rm -f ~/Library/LaunchAgents/$(launchd_label).plist"
    else
      echo "  systemctl --user disable --now $(systemd_unit).service"
      echo "  rm -f ~/.config/systemd/user/$(systemd_unit).service && systemctl --user daemon-reload"
    fi
    echo "  $UNINSTALL_RUNTIME ps -aq --filter label=nanoclaw-install=$(_nanoclaw_install_slug) | xargs -r $UNINSTALL_RUNTIME rm -f"
    echo "  $UNINSTALL_RUNTIME rmi $(container_image_base):latest"
    echo "  rm -f ~/.local/bin/ncl    # only if it points at this folder"
    echo "  rm -rf \"$(dirname "$PROJECT_ROOT")/.nanoclaw-updates/$(_nanoclaw_install_slug)\""
    echo ""
    echo "Then back up $PROJECT_ROOT/.env if you need the keys, and delete the folder."
    exit 1
  fi
done

LOGS_DIR="$PROJECT_ROOT/logs"
STEPS_DIR="$LOGS_DIR/setup-steps"
PROGRESS_LOG="$LOGS_DIR/setup.log"

# Diagnostics: persisted install-id + fire-and-forget emit.
# shellcheck source=setup/lib/diagnostics.sh
source "$PROJECT_ROOT/setup/lib/diagnostics.sh"
emit_launch_diagnostic() {
  ph_event setup_launched \
    platform="$(uname -s | tr 'A-Z' 'a-z')" \
    is_wsl="$([ -f /proc/version ] && grep -qi 'microsoft\|wsl' /proc/version 2>/dev/null && echo true || echo false)"
}
[ "$DRIVER_MODE" = true ] || emit_launch_diagnostic

# ─── log helpers ────────────────────────────────────────────────────────

ts_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

write_header() {
  local ts
  ts=$(ts_utc)
  local branch commit
  branch=$(git branch --show-current 2>/dev/null || echo unknown)
  commit=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
  {
    echo "## ${ts} · setup:auto started"
    echo "  invocation: nanoclaw.sh"
    echo "  user: $(whoami)"
    echo "  cwd: ${PROJECT_ROOT}"
    echo "  branch: ${branch}"
    echo "  commit: ${commit}"
    echo ""
  } > "$PROGRESS_LOG"
}

# grep_field FIELD FILE — first value of FIELD: from a status block.
grep_field() {
  grep "^$1:" "$2" 2>/dev/null | head -1 | sed "s/^$1: *//" || true
}

write_bootstrap_entry() {
  local status=$1 dur=$2 raw=$3
  local ts
  ts=$(ts_utc)
  local platform is_wsl node_version deps_ok native_ok has_build_tools
  platform=$(grep_field PLATFORM "$raw")
  is_wsl=$(grep_field IS_WSL "$raw")
  node_version=$(grep_field NODE_VERSION "$raw" | head -1)
  deps_ok=$(grep_field DEPS_OK "$raw")
  native_ok=$(grep_field NATIVE_OK "$raw")
  has_build_tools=$(grep_field HAS_BUILD_TOOLS "$raw")
  {
    echo "=== [${ts}] bootstrap [${dur}s] → ${status} ==="
    [ -n "$platform" ]        && echo "  platform: ${platform}"
    [ -n "$is_wsl" ]          && echo "  is_wsl: ${is_wsl}"
    [ -n "$node_version" ]    && echo "  node_version: ${node_version}"
    [ -n "$deps_ok" ]         && echo "  deps_ok: ${deps_ok}"
    [ -n "$native_ok" ]       && echo "  native_ok: ${native_ok}"
    [ -n "$has_build_tools" ] && echo "  has_build_tools: ${has_build_tools}"
    # Emit the raw path relative to PROJECT_ROOT so the progression log
     # is portable and matches the TS-side format (logs/setup-steps/NN-…).
    echo "  raw: ${raw#${PROJECT_ROOT}/}"
    echo ""
  } >> "$PROGRESS_LOG"
}

write_abort_entry() {
  local step=$1 error=$2
  local ts
  ts=$(ts_utc)
  echo "## ${ts} · aborted at ${step} (${error})" >> "$PROGRESS_LOG"
}

# ─── bash-side "clack-alike" status line ────────────────────────────────

use_ansi() { [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; }
dim()     { use_ansi && printf '\033[2m%s\033[0m' "$1" || printf '%s' "$1"; }
gray()    { use_ansi && printf '\033[90m%s\033[0m' "$1" || printf '%s' "$1"; }
red()     { use_ansi && printf '\033[31m%s\033[0m' "$1" || printf '%s' "$1"; }
bold()    { use_ansi && printf '\033[1m%s\033[0m' "$1" || printf '%s' "$1"; }
# brand cyan (≈ #2BB7CE) — truecolor when supported, 16-color cyan fallback.
brand_bold() {
  if use_ansi; then
    if [ "${COLORTERM:-}" = "truecolor" ] || [ "${COLORTERM:-}" = "24bit" ]; then
      printf '\033[1;38;2;43;183;206m%s\033[0m' "$1"
    else
      printf '\033[1;36m%s\033[0m' "$1"
    fi
  else
    printf '%s' "$1"
  fi
}
clear_line() { use_ansi && printf '\r\033[2K' || printf '\n'; }

spinner_start() {
  if [ "$DRIVER_MODE" = true ]; then
    printf '{"protocol":"nanoclaw.driver.v1","operation":"setup","type":"progress","stepId":"bootstrap","state":"running","label":"Installing the basics"}\n'
  else
    printf '%s  %s…' "$(gray '◒')" "$1"
  fi
}
spinner_update()  { [ "$DRIVER_MODE" = true ] || { clear_line; printf '%s  %s… %s' "$(gray '◒')" "$1" "$(dim "(${2}s)")"; }; }
spinner_success() {
  if [ "$DRIVER_MODE" = true ]; then
    printf '{"protocol":"nanoclaw.driver.v1","operation":"setup","type":"progress","stepId":"bootstrap","state":"succeeded","label":"Basics ready"}\n'
  else
    clear_line; printf '%s  %s %s\n' "$(gray '◇')" "$1" "$(dim "(${2}s)")"
  fi
}
spinner_failure() {
  if [ "$DRIVER_MODE" = true ]; then
    printf '{"protocol":"nanoclaw.driver.v1","operation":"setup","type":"progress","stepId":"bootstrap","state":"failed","label":"Installing the basics"}\n'
  else
    clear_line; printf '%s  %s %s\n' "$(red '✗')" "$1" "$(dim "(${2}s)")"
  fi
}

# ─── fresh-run setup ────────────────────────────────────────────────────

# Machine preflight failures must not create setup state. Terminal mode keeps
# its established log timing.
if [ "$DRIVER_MODE" = false ]; then
  rm -rf "$STEPS_DIR"
  rm -f  "$PROGRESS_LOG"
  mkdir -p "$STEPS_DIR" "$LOGS_DIR"
  write_header
fi

# NanoClaw splash — under-the-sea lobster mascot in truecolor braille,
# with the figlet wordmark and taglines below. Pre-rendered into
# assets/setup-splash.txt (built from assets/nanoclaw-icon.png via chafa +
# figlet); the bash script just streams the literal frame. clack's intro
# then carries the "let's get you set up" framing — setup:auto sees
# NANOCLAW_BOOTSTRAPPED=1 and skips re-printing the wordmark.
[ "$DRIVER_MODE" = true ] || cat "$PROJECT_ROOT/assets/setup-splash.txt"

# ─── pre-flight: minimum hardware specs ────────────────────────────────
# NanoClaw runs an agent container per session. Below this threshold the
# host + container + agent will struggle (OOM under load). Soft warn — the
# user can override.

# RAM floor is set below 4 GB because "4 GB" VMs typically report 3700–3900 MB
# after kernel reserves (e.g. Hetzner CX21 ≈ 3814, AWS t3.medium ≈ 3800).
MIN_MEM_MB=3700

detect_mem_mb() {
  case "$(uname -s)" in
    Linux)
      awk '/^MemTotal:/ {printf "%d", $2 / 1024}' /proc/meminfo 2>/dev/null
      ;;
    Darwin)
      local bytes
      bytes=$(sysctl -n hw.memsize 2>/dev/null || echo 0)
      echo $(( bytes / 1024 / 1024 ))
      ;;
  esac
}

MEM_MB=$(detect_mem_mb)
: "${MEM_MB:=0}"

LOW_MEM=false
[ "$MEM_MB" -gt 0 ] && [ "$MEM_MB" -lt "$MIN_MEM_MB" ] && LOW_MEM=true

if [ "$LOW_MEM" = true ]; then
  if [ "$DRIVER_MODE" = true ]; then
    if ! driver_has_ack low-memory; then
      DRIVER_RERUN_ARGS=$(driver_recovery_args low-memory ${DRIVER_ARGS[@]+"${DRIVER_ARGS[@]}"})
      printf '{"protocol":"nanoclaw.driver.v1","operation":"setup","type":"error","code":"low_memory","message":"This machine has less than the recommended 4 GB of memory.","recovery":[{"kind":"rerun","args":%s}]}\n' "$DRIVER_RERUN_ARGS"
      exit 1
    fi
  else
  printf '  %s\n' "$(red 'Warning: this machine likely cannot run NanoClaw.')"
  printf '  %s\n' "$(dim 'NanoClaw recommends a 4 GB+ RAM machine. Below this, the host + agent')"
  printf '  %s\n' "$(dim 'container will run out of memory under most workloads. A stronger')"
  printf '  %s\n' "$(dim 'machine is strongly recommended.')"
  printf '  %s\n' "$(dim "  · Detected RAM: ${MEM_MB} MB")"
  printf '\n'
  read -r -p "  $(bold 'Try anyway?') [y/N] " SPECS_ANS </dev/tty

  case "${SPECS_ANS:-N}" in
    [Yy]*)
      ph_event setup_low_specs_continued mem_mb="$MEM_MB" low_mem="$LOW_MEM"
      printf '\n'
      ;;
    *)
      ph_event setup_low_specs_aborted mem_mb="$MEM_MB" low_mem="$LOW_MEM"
      printf '\n  %s\n\n' "$(dim 'Aborted. Re-run after upgrading the host.')"
      exit 1
      ;;
  esac
  fi
fi

# ─── pre-flight: Google Cloud VM warning (Linux) ──────────────────────
# NanoClaw is known to not run reliably on Google Compute Engine instances.
# Warn early — before the root check or bootstrap spinner — so users can
# switch providers before sinking time into setup. Detection uses DMI
# (no network round-trip), which on GCE reports "Google" / "Google
# Compute Engine".
if [ "$(uname -s)" = "Linux" ] \
  && { grep -qi 'Google' /sys/class/dmi/id/product_name 2>/dev/null \
    || grep -qi 'Google' /sys/class/dmi/id/sys_vendor   2>/dev/null; }; then
  if [ "$DRIVER_MODE" = true ]; then
    if ! driver_has_ack gce; then
      DRIVER_RERUN_ARGS=$(driver_recovery_args gce ${DRIVER_ARGS[@]+"${DRIVER_ARGS[@]}"})
      printf '{"protocol":"nanoclaw.driver.v1","operation":"setup","type":"error","code":"gce_unsupported","message":"Google Cloud VM detected; NanoClaw is unlikely to run reliably there.","recovery":[{"kind":"rerun","args":%s},{"kind":"manual","title":"Use another provider","instructions":["Move this checkout to a supported non-GCE host, then rerun setup."]}]}\n' "$DRIVER_RERUN_ARGS"
      exit 1
    fi
  else
  printf '  %s\n' "$(red 'Warning: Google Cloud VM detected.')"
  printf '  %s\n' "$(dim 'Google blocks sudo commands, so NanoClaw is unlikely to run successfully on this VM.')"
  printf '  %s\n\n' "$(dim 'If you want to run NanoClaw successfully, switch to a different provider (Hetzner, Hostinger, exe.dev and others..).')"
  read -r -p "  $(bold 'Try anyway?') [y/N] " GCE_ANS </dev/tty

  case "${GCE_ANS:-N}" in
    [Yy]*)
      ph_event setup_gce_continued
      printf '\n'
      ;;
    *)
      ph_event setup_gce_aborted
      printf '\n  %s\n\n' "$(dim 'Aborted. Re-run on a non-GCE host to continue.')"
      exit 1
      ;;
  esac
  fi
fi

# ─── pre-flight: root user warning (Linux) ────────────────────────────
if [ "$(uname -s)" = "Linux" ] && [ "$(id -u)" -eq 0 ]; then
  if [ "$DRIVER_MODE" = true ]; then
    if ! driver_has_ack root; then
      DRIVER_RERUN_ARGS=$(driver_recovery_args root ${DRIVER_ARGS[@]+"${DRIVER_ARGS[@]}"})
      printf '{"protocol":"nanoclaw.driver.v1","operation":"setup","type":"error","code":"root_user","message":"Running NanoClaw as root can cause unsafe service and file ownership.","recovery":[{"kind":"rerun","args":%s},{"kind":"manual","title":"Create a regular Linux user","instructions":["Create a non-root user with sudo access.","Log in as that user and rerun setup."]}]}\n' "$DRIVER_RERUN_ARGS"
      exit 1
    fi
  else
  printf '  %s\n' \
    "$(red 'Warning: you are running as root.')"
  printf '  %s\n' \
    "$(dim "Running NanoClaw as root is not recommended. It can cause permission")"
  printf '  %s\n\n' \
    "$(dim "issues with containers, services, and file ownership.")"
  printf '  %s\n' "$(bold '1)') $(dim 'Show me instructions for creating a new Linux user')"
  printf '  %s\n\n' "$(bold '2)') $(dim 'Continue setting up NanoClaw as root user (not recommended)')"
  read -r -p "  $(bold 'Choose [1/2]: ')" ROOT_ANS </dev/tty

  case "${ROOT_ANS:-1}" in
    2)
      ph_event setup_root_continued
      printf '\n'
      ;;
    *)
      ph_event setup_root_aborted
      printf '\n  %s\n' "$(bold 'To set up a regular user (via SSH):')"
      printf '  %s\n\n' "$(dim 'Not using SSH? Refer to your hosting provider docs or ask your coding agent to help you set up SSH access.')"
      printf '  %s\n' "$(dim '1. Create a new user:           adduser nanoclaw')"
      printf '  %s\n' "$(dim '2. Add to sudo group:           usermod -aG sudo nanoclaw')"
      printf '  %s\n' "$(dim '3. Enable passwordless sudo:    echo "nanoclaw ALL=(ALL) NOPASSWD:ALL" | tee /etc/sudoers.d/nanoclaw')"
      printf '  %s\n' "$(dim '4. Log out:                     exit')"
      printf '  %s\n' "$(dim '5. Log back in as the new user: ssh nanoclaw@your-server')"
      printf '  %s\n' "$(dim '6. Clone the repo:              git clone https://github.com/nanocoai/nanoclaw.git && cd nanoclaw')"
      printf '  %s\n\n' "$(dim '7. Re-run setup:               bash nanoclaw.sh')"
      exit 1
      ;;
  esac
  fi
fi

# ─── pre-flight: Homebrew on macOS ─────────────────────────────────────
# setup/install-node.sh and setup/install-docker.sh both require `brew` on
# macOS. On a factory Mac there's no brew, and those helpers would fail
# later inside the bootstrap spinner with a cryptic error. Prompt here,
# before the spinner starts, so the user knows what's about to happen and
# brew's own interactive sudo/CLT prompts stay readable.
if [ "$(uname -s)" = "Darwin" ] && ! command -v brew >/dev/null 2>&1; then
  if [ "$DRIVER_MODE" = true ]; then
    printf '{"protocol":"nanoclaw.driver.v1","operation":"setup","type":"error","code":"homebrew_required","message":"Homebrew is required before machine setup can continue.","recovery":[{"kind":"manual","title":"Install Homebrew","instructions":["Install Homebrew from https://brew.sh in a terminal.","Rerun the same NanoClaw setup command."]}]}\n'
    exit 1
  fi
  printf '  %s\n' \
    "$(dim "Homebrew isn't installed. NanoClaw uses it to install Node and Docker on your Mac.")"
  printf '  %s\n\n' \
    "$(dim "This also installs Apple's Command Line Tools, which can take 5-10 minutes.")"
  read -r -p "  $(bold 'Install Homebrew now?') [Y/n] " BREW_ANS </dev/tty

  case "${BREW_ANS:-Y}" in
    [Yy]*|'')
      printf '\n'
      # Official installer. Runs interactively, triggers xcode-select --install
      # for Command Line Tools, and prompts for the user's password for sudo.
      # `|| true` so a user-cancelled install doesn't kill us via `set -e`;
      # the PATH check below is the real gate.
      /bin/bash -c \
        "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
        || true

      # Put brew on PATH for this session (the installer writes to
      # .zprofile/.bash_profile for future shells, but not this one).
      if [ -x /opt/homebrew/bin/brew ]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
      elif [ -x /usr/local/bin/brew ]; then
        eval "$(/usr/local/bin/brew shellenv)"
      fi

      if ! command -v brew >/dev/null 2>&1; then
        printf '\n  %s %s\n' "$(red '✗')" "Homebrew install didn't complete."
        printf '  %s\n\n' \
          "$(dim 'Install manually from https://brew.sh and re-run: bash nanoclaw.sh')"
        exit 1
      fi
      printf '\n'
      ;;
    *)
      printf '\n  %s\n\n' \
        "$(dim 'NanoClaw needs Homebrew. Install it from https://brew.sh and re-run.')"
      exit 1
      ;;
  esac
fi

# ─── first step: install the basics (Node + pnpm + native modules) ─────

if [ "$DRIVER_MODE" = true ]; then
  rm -rf "$STEPS_DIR"
  rm -f  "$PROGRESS_LOG"
  mkdir -p "$STEPS_DIR" "$LOGS_DIR"
  write_header
  emit_launch_diagnostic
fi

BOOTSTRAP_RAW="${STEPS_DIR}/01-bootstrap.log"
BOOTSTRAP_LABEL="Installing the basics"
BOOTSTRAP_START=$(date +%s)

# Run in the background so terminal mode can tick elapsed time. Machine mode
# owns the process group so cancellation reaches bootstrap descendants.
BOOTSTRAP_EXIT_FILE=""
BOOTSTRAP_MONITOR=false
BOOTSTRAP_PID=""
DRIVER_STDIN_WATCH_PID=""
if [ "$DRIVER_MODE" = true ]; then
  DRIVER_PARENT_PID=$$
  exec 3<&0
  driver_stop_stdin_watcher() {
    if [ -n "$DRIVER_STDIN_WATCH_PID" ]; then
      kill "$DRIVER_STDIN_WATCH_PID" 2>/dev/null || true
      wait "$DRIVER_STDIN_WATCH_PID" 2>/dev/null || true
      DRIVER_STDIN_WATCH_PID=""
    fi
    exec 3<&-
  }
  driver_cancel_bootstrap() {
    trap - INT TERM
    driver_stop_stdin_watcher
    if [ -n "$BOOTSTRAP_PID" ]; then
      kill -TERM -- "-$BOOTSTRAP_PID" 2>/dev/null || kill -TERM "$BOOTSTRAP_PID" 2>/dev/null || true
      sleep 0.25
      kill -KILL -- "-$BOOTSTRAP_PID" 2>/dev/null || kill -KILL "$BOOTSTRAP_PID" 2>/dev/null || true
      wait "$BOOTSTRAP_PID" 2>/dev/null || true
    fi
    [ "$BOOTSTRAP_MONITOR" = false ] || set +m
    printf '{"protocol":"nanoclaw.driver.v1","operation":"setup","type":"cancelled","lastStepId":"bootstrap"}\n'
    exit 2
  }
  trap driver_cancel_bootstrap INT TERM
  (IFS= read -r _ || true; kill -TERM "$DRIVER_PARENT_PID" 2>/dev/null || true) <&3 &
  DRIVER_STDIN_WATCH_PID=$!
  spinner_start "$BOOTSTRAP_LABEL"
  if [ "${NANOCLAW_DISABLE_SETSID:-0}" != 1 ] && command -v setsid >/dev/null 2>&1; then
    NANOCLAW_BOOTSTRAP_LOG="$BOOTSTRAP_RAW" setsid bash setup.sh </dev/null > "$BOOTSTRAP_RAW" 2>&1 &
  else
    set -m
    BOOTSTRAP_MONITOR=true
    NANOCLAW_BOOTSTRAP_LOG="$BOOTSTRAP_RAW" bash setup.sh </dev/null > "$BOOTSTRAP_RAW" 2>&1 &
  fi
  BOOTSTRAP_PID=$!
else
  spinner_start "$BOOTSTRAP_LABEL"
  BOOTSTRAP_EXIT_FILE=$(mktemp -t nanoclaw-bootstrap-exit.XXXXXX)
  (
    export NANOCLAW_BOOTSTRAP_LOG="$BOOTSTRAP_RAW"
    if bash setup.sh > "$BOOTSTRAP_RAW" 2>&1; then
      echo 0 > "$BOOTSTRAP_EXIT_FILE"
    else
      echo $? > "$BOOTSTRAP_EXIT_FILE"
    fi
  ) &
  BOOTSTRAP_PID=$!
fi

while kill -0 "$BOOTSTRAP_PID" 2>/dev/null; do
  sleep 1
  if kill -0 "$BOOTSTRAP_PID" 2>/dev/null; then
    spinner_update "$BOOTSTRAP_LABEL" "$(( $(date +%s) - BOOTSTRAP_START ))"
  fi
done
if [ "$DRIVER_MODE" = true ]; then
  if wait "$BOOTSTRAP_PID"; then BOOTSTRAP_RC=0; else BOOTSTRAP_RC=$?; fi
  driver_stop_stdin_watcher
  [ "$BOOTSTRAP_MONITOR" = false ] || set +m
  trap - INT TERM
  BOOTSTRAP_STATUS=$(grep '^STATUS:' "$BOOTSTRAP_RAW" 2>/dev/null | tail -1 | sed 's/^STATUS: *//' || true)
  if [ "$BOOTSTRAP_RC" -eq 0 ] \
    && { [ "$BOOTSTRAP_STATUS" != success ] \
      || ! command -v node >/dev/null 2>&1 \
      || [ ! -x "$PROJECT_ROOT/node_modules/.bin/tsx" ]; }; then
    BOOTSTRAP_RC=1
  fi
else
  wait "$BOOTSTRAP_PID" 2>/dev/null || true
  BOOTSTRAP_RC=$(cat "$BOOTSTRAP_EXIT_FILE")
  rm -f "$BOOTSTRAP_EXIT_FILE"
fi
BOOTSTRAP_DUR=$(( $(date +%s) - BOOTSTRAP_START ))

if [ "$BOOTSTRAP_RC" -eq 0 ]; then
  spinner_success "Basics ready" "$BOOTSTRAP_DUR"
  write_bootstrap_entry success "$BOOTSTRAP_DUR" "$BOOTSTRAP_RAW"
else
  spinner_failure "Couldn't install the basics" "$BOOTSTRAP_DUR"
  write_bootstrap_entry failed "$BOOTSTRAP_DUR" "$BOOTSTRAP_RAW"
  write_abort_entry bootstrap "exit-${BOOTSTRAP_RC}"

  if [ "$DRIVER_MODE" = true ]; then
    printf '{"protocol":"nanoclaw.driver.v1","operation":"setup","type":"error","code":"bootstrap_failed","stepId":"bootstrap","message":"Could not install the required runtime non-interactively.","recovery":[{"kind":"manual","title":"Inspect the bootstrap log","instructions":["Review logs/setup-steps/01-bootstrap.log without sharing secrets.","Complete any terminal-owned prerequisite, then rerun setup."]}]}\n'
    exit 1
  fi

  echo
  echo "$(dim '── last 40 lines of ')$(dim "$BOOTSTRAP_RAW")$(dim ' ──')"
  tail -40 "$BOOTSTRAP_RAW"
  echo
  echo "$(dim "Full raw log: $BOOTSTRAP_RAW")"
  echo "$(dim "Progression:  $PROGRESS_LOG")"
  exit 1
fi

# ─── hand off to setup:auto ────────────────────────────────────────────

# NANOCLAW_BOOTSTRAPPED=1 tells setup/auto.ts to skip the wordmark (we
# already printed it) and to append to the progression log rather than
# wipe it.
export NANOCLAW_BOOTSTRAPPED=1

# setup.sh may have just installed pnpm via npm into a prefix that's not on
# our PATH (custom `npm config set prefix`, or the default prefix missing
# from the shell's login PATH). Its PATH mutation doesn't propagate back
# to us — so replay the same lookup here before the exec.
if ! command -v pnpm >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  NPM_PREFIX="$(npm config get prefix 2>/dev/null)"
  if [ -n "$NPM_PREFIX" ] && [ -x "$NPM_PREFIX/bin/pnpm" ]; then
    export PATH="$NPM_PREFIX/bin:$PATH"
  fi
fi

# --silent suppresses pnpm's `> nanoclaw@2.0.0 setup:auto / > tsx setup/auto.ts`
# preamble so the flow continues visually from "Basics installed" straight
# into setup:auto's spinner. exec so signals (Ctrl-C) propagate directly.
# pnpm forwards arguments after the script name directly. Passing an extra
# `--` would reach setup:auto and make its parser stop before our flags.
if [ "$DRIVER_MODE" = true ]; then
  export NANOCLAW_PROTOCOL=nanoclaw.driver.v1
  export NANOCLAW_OPERATION=setup
  export NANOCLAW_DRIVER_SHELL_HELLO=1
  exec "$PROJECT_ROOT/node_modules/.bin/tsx" "$PROJECT_ROOT/setup/auto.ts" "$@"
fi
exec pnpm --silent run setup:auto "$@"
