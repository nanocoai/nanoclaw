#!/usr/bin/env bash
# Setup helper: install-node — bundles Node 22 install into one idempotent
# script so /new-setup can run it without needing `curl | sudo -E bash -` in
# the allowlist (that pattern is inherently unmatchable — bash reads from
# stdin, so pre-approval can't inspect what's being executed).
#
# The script itself is the allowlisted unit; the pipes and sudo live inside
# it. Pure bash by design — runs before Node exists on the host.
set -euo pipefail

REQUIRED_NODE_MAJOR=20

echo "=== NANOCLAW SETUP: INSTALL_NODE ==="

if command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(node --version 2>/dev/null || echo unknown)"
  major="${NODE_VERSION#v}"
  major="${major%%.*}"
  if [ "$major" -ge "$REQUIRED_NODE_MAJOR" ] 2>/dev/null; then
    echo "STATUS: already-installed"
    echo "NODE_VERSION: $NODE_VERSION"
    echo "=== END ==="
    exit 0
  fi
  if [ "${NANOCLAW_NODE_UPGRADE_OK:-0}" != "1" ]; then
    # An existing Node is never replaced without consent — the honest
    # non-consented outcome for a too-old Node is a clear failure naming
    # the fix. nanoclaw.sh gathers that consent interactively.
    echo "STATUS: node-too-old"
    echo "NODE_VERSION: $NODE_VERSION"
    echo "ERROR: Node $NODE_VERSION is too old. NanoClaw needs Node ${REQUIRED_NODE_MAJOR} or higher. This script does not replace an installed Node without consent. Do one of these: (1) Update or remove your Node, then run the setup again. (2) Run bash nanoclaw.sh and accept the Node installation."
    echo "=== END ==="
    exit 1
  fi
  echo "STEP: node-upgrade-consented"
  echo "NODE_OLD_VERSION: $NODE_VERSION"
fi

if command -v uvx >/dev/null 2>&1; then
  echo "STEP: uvx-nodeenv"
  uvx nodeenv -n lts ~/node
  mkdir -p ~/.local/bin
  ln -sf ~/node/bin/node ~/.local/bin/node
  ln -sf ~/node/bin/npm ~/.local/bin/npm
  ln -sf ~/node/bin/npx ~/.local/bin/npx
  ln -sf ~/node/bin/pnpm ~/.local/bin/pnpm
else
  case "$(uname -s)" in
    Darwin)
      echo "STEP: brew-install-node"
      if ! command -v brew >/dev/null 2>&1; then
        echo "STATUS: failed"
        echo "ERROR: Homebrew not installed. Install brew first (https://brew.sh) then re-run."
        echo "=== END ==="
        exit 1
      fi
      brew install node@22
      # node@22 is keg-only (versioned formula): brew installs it without
      # linking anything onto PATH. Mirror the uvx branch and expose it
      # via ~/.local/bin so PATH-prepending callers resolve the new node.
      BREW_NODE_PREFIX="$(brew --prefix node@22)"
      mkdir -p ~/.local/bin
      ln -sf "$BREW_NODE_PREFIX/bin/node" ~/.local/bin/node
      ln -sf "$BREW_NODE_PREFIX/bin/npm" ~/.local/bin/npm
      ln -sf "$BREW_NODE_PREFIX/bin/npx" ~/.local/bin/npx
      ;;
    Linux)
      echo "STEP: nodesource-setup"
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
      echo "STEP: apt-install-nodejs"
      sudo apt-get install -y nodejs
      ;;
    *)
      echo "STATUS: failed"
      echo "ERROR: Unsupported platform: $(uname -s)"
      echo "=== END ==="
      exit 1
      ;;
  esac
fi

if ! command -v node >/dev/null 2>&1; then
  echo "STATUS: failed"
  echo "ERROR: node not found on PATH after install"
  echo "=== END ==="
  exit 1
fi

NODE_VERSION="$(node --version 2>/dev/null || echo unknown)"
major="${NODE_VERSION#v}"
major="${major%%.*}"
if ! [ "$major" -ge "$REQUIRED_NODE_MAJOR" ] 2>/dev/null; then
  echo "STATUS: failed"
  echo "ERROR: The PATH still finds Node $NODE_VERSION after the installation. Put the new Node first in the PATH (for example ~/.local/bin). Then run the setup again."
  echo "=== END ==="
  exit 1
fi

echo "STATUS: installed"
echo "NODE_VERSION: $NODE_VERSION"
echo "=== END ==="
