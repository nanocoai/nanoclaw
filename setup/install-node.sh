#!/usr/bin/env bash
# Setup helper: install-node — bundles Node 22 install into one idempotent
# script so /new-setup can run it without needing `curl | sudo -E bash -` in
# the allowlist (that pattern is inherently unmatchable — bash reads from
# stdin, so pre-approval can't inspect what's being executed).
#
# The script itself is the allowlisted unit; the pipes and sudo live inside
# it. Pure bash by design — runs before Node exists on the host.
set -euo pipefail

echo "=== NANOCLAW SETUP: INSTALL_NODE ==="

if command -v node >/dev/null 2>&1; then
  echo "STATUS: already-installed"
  echo "NODE_VERSION: $(node --version)"
  echo "=== END ==="
  exit 0
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
      ;;
    Linux)
      ID_LIKE=""
      ID=""
      if [ -f /etc/os-release ]; then
        # shellcheck disable=SC1091
        . /etc/os-release
      fi
      case "$ID_LIKE $ID" in
        *debian*|*ubuntu*)
          echo "STEP: nodesource-setup"
          curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
          echo "STEP: apt-install-nodejs"
          sudo apt-get install -y nodejs
          ;;
        *rhel*|*fedora*|*centos*)
          echo "STEP: nodesource-setup-rpm"
          curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo -E bash -
          echo "STEP: dnf-install-nodejs"
          if command -v dnf >/dev/null 2>&1; then
            sudo dnf install -y nodejs
          else
            sudo yum install -y nodejs
          fi
          ;;
        *suse*)
          echo "STEP: zypper-install-nodejs"
          sudo zypper --non-interactive install nodejs22
          ;;
        *)
          echo "STATUS: failed"
          echo "ERROR: Unsupported Linux distro: ID=$ID ID_LIKE=$ID_LIKE"
          echo "ERROR: This script supports Debian/Ubuntu and RHEL/Fedora/CentOS/openSUSE out of the box."
          echo "ERROR: On other distros, install Node 22 via your distro's package manager (or nvm/uv/fnm), then re-run this script."
          echo "=== END ==="
          exit 1
          ;;
      esac
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

echo "STATUS: installed"
echo "NODE_VERSION: $(node --version)"
echo "=== END ==="
