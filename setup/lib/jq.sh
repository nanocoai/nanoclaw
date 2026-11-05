# jq.sh — install jq, which skills use to read API replies.
#
# Sourced by setup.sh, which installs it, and sudo-preflight.sh, which asks
# for sudo before the bootstrap spinner. Recent macOS ships /usr/bin/jq; an
# older Mac gets it from Homebrew, which nanoclaw.sh already requires.
# Uses bash builtins plus uname/id/sudo only: Node may not exist yet.

# setup:auto puts ~/.local/bin on PATH, so a jq there already counts.
jq_present() {
  command -v jq >/dev/null 2>&1 || [ -x "$HOME/.local/bin/jq" ]
}

# The package-manager command that installs jq here (without sudo), or nothing
# when jq is present or no manager we know is on PATH.
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

# True when installing jq here runs sudo: Linux, not root, a manager to run.
jq_needs_sudo() {
  [ "$(uname -s 2>/dev/null)" = "Linux" ] || return 1
  [ "$(id -u 2>/dev/null)" != "0" ] || return 1
  [ -n "$(jq_install_command)" ]
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
      *) return 1 ;;
    esac
  fi
  hash -r 2>/dev/null || true
  jq_present
}
