# sudo-preflight.sh — ask for the sudo password before setup hides it.
#
# Source after defining dim/red (nanoclaw.sh's status-line helpers):
#
#   if ! sudo_preflight; then exit 1; fi
#
# On Linux, the bootstrap installs Node and jq with sudo behind its spinner,
# so sudo's prompt can't be seen and times out. One `sudo -v` in the open
# caches the timestamp those calls reuse. Docker is left to setup:auto, which
# asks right before its container step (setup/lib/sudo-preflight.ts).
# Uses bash builtins plus uname/id/node/sudo only: Node may not exist yet.

# shellcheck source=setup/lib/node-version.sh
source "${BASH_SOURCE[0]%/*}/node-version.sh"
# shellcheck source=setup/lib/jq.sh
source "${BASH_SOURCE[0]%/*}/jq.sh"

# Prints "Node" or "a newer Node" when setup.sh will run install-node.sh's
# NodeSource install, the one path that uses sudo. It doesn't for uvx, for a
# Node node_use_patched finds, or for a Node install-node.sh refuses to
# replace (a version manager's, 23, 25, a pre-release).
sudo_preflight_node() {
  local current
  command -v uvx >/dev/null 2>&1 && return 0
  # A subshell, so the PATH it picks stays setup.sh's to choose.
  (node_use_patched) && return 0
  if ! current=$(command -v node); then
    echo "Node"
  elif node_from_apt "$current" && node_install_line "$(node --version 2>/dev/null)" >/dev/null; then
    echo "a newer Node"
  fi
  return 0
}

# What the bootstrap will install with sudo ("Node", "a newer Node", "jq", or
# Node and jq); exit 1 when nothing needs it.
sudo_preflight_needs() {
  [ "$(uname -s 2>/dev/null)" = "Linux" ] || return 1
  [ "$(id -u 2>/dev/null)" != "0" ] || return 1
  local node jq=""
  node=$(sudo_preflight_node)
  jq_needs_sudo && jq="jq"
  if [ -n "$node" ] && [ -n "$jq" ]; then
    echo "$node and $jq"
  elif [ -n "$node$jq" ]; then
    echo "$node$jq"
  else
    return 1
  fi
}

# Someone at a terminal who can answer sudo. Without one, setup keeps its
# old behaviour rather than wait on a prompt nobody will see.
sudo_preflight_interactive() {
  [ -t 0 ] && (exec </dev/tty) 2>/dev/null
}

# Returns 1 only when sudo was needed and the user couldn't get it.
sudo_preflight() {
  local needs
  needs=$(sudo_preflight_needs) || return 0
  command -v sudo >/dev/null 2>&1 || return 0
  sudo_preflight_interactive || return 0
  sudo -n true >/dev/null 2>&1 && return 0

  printf '  %s\n' "$(dim "Setup needs to install ${needs}, so it will ask for your Linux password (sudo).")"
  if sudo -v -p '  [sudo] password for %p: '; then
    printf '\n'
    return 0
  fi
  # Only skills need jq, so a user without sudo can still install NanoClaw.
  if [ "$needs" = "jq" ]; then
    printf '\n  %s\n\n' "$(dim 'Going on without jq for now.')"
    return 0
  fi
  local minimum="Node (minimum ${NODE_MINIMUMS// / / })"
  printf '\n  %s %s\n' "$(red '✗')" "Couldn't get sudo access to install ${needs}."
  printf '  %s\n\n' \
    "$(dim "Re-run bash nanoclaw.sh and enter your password, or install ${needs/Node/$minimum} yourself first.")"
  return 1
}
