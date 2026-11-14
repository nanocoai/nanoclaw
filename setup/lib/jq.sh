# jq.sh — install jq for skills; sourced by setup.sh and sudo-preflight.sh, before Node exists.

jq_present() {
  command -v jq >/dev/null 2>&1
}

jq_install_command() {
  jq_present && return 0
  case "$(uname -s 2>/dev/null)" in
    Darwin)
      command -v brew >/dev/null 2>&1 && echo "brew install jq"
      ;;
    Linux)
      if command -v apt-get >/dev/null 2>&1; then
        echo "apt-get install -y -qq jq"
      elif command -v dnf >/dev/null 2>&1; then
        echo "dnf install -y -q jq"
      elif command -v yum >/dev/null 2>&1; then
        echo "yum install -y -q jq"
      elif command -v zypper >/dev/null 2>&1; then
        echo "zypper --non-interactive --quiet install jq"
      elif command -v pacman >/dev/null 2>&1; then
        echo "pacman -S --noconfirm --needed jq"
      elif command -v apk >/dev/null 2>&1; then
        echo "apk add --quiet jq"
      fi
      ;;
  esac
  return 0
}

jq_needs_sudo() {
  [ "$(uname -s 2>/dev/null)" = "Linux" ] || return 1
  [ "$(id -u 2>/dev/null)" != "0" ] || return 1
  [ -n "$(jq_install_command)" ]
}

# True when pacman has never synced its package lists (container and cloud images).
# False when pacman-conf can't say where they live, or this user can't list them,
# so an odd host is never upgraded.
pacman_never_synced() {
  local db dir
  dir=$(pacman-conf DBPath 2>/dev/null) && [ -n "$dir" ] || return 1
  dir="${dir%/}/sync"
  [ -r "$dir" ] && [ -x "$dir" ] || return 1
  for db in "$dir"/*.db; do
    [ -e "$db" ] && return 1
  done
  return 0
}

# Installs jq when missing; returns 1 when it is still missing. Never prompts:
# its output goes to a log behind a spinner, so sudo runs with -n and reuses
# the password nanoclaw.sh's pre-flight asked for.
ensure_jq() {
  local cmd sudo=""
  jq_present && return 0
  cmd=$(jq_install_command)
  [ -n "$cmd" ] || return 1
  if jq_needs_sudo; then
    command -v sudo >/dev/null 2>&1 || return 1
    sudo="sudo -n"
  fi
  # shellcheck disable=SC2086 # $sudo and $cmd are word lists on purpose
  if ! $sudo env DEBIAN_FRONTEND=noninteractive HOMEBREW_NO_AUTO_UPDATE=1 $cmd; then
    # A fresh distro can have empty package lists: refresh once and retry.
    case "$cmd" in
      apt-get*) $sudo apt-get update -qq && $sudo env DEBIAN_FRONTEND=noninteractive $cmd || return 1 ;;
      # pacman -Sy alone is a partial upgrade, which Arch doesn't support: sync with a full -Syu,
      # and only on a host that never synced, so setup never upgrades a system someone maintains.
      pacman*) pacman_never_synced && $sudo pacman -Syu --noconfirm --needed jq || return 1 ;;
      *) return 1 ;;
    esac
  fi
  hash -r 2>/dev/null || true
  jq_present
}
