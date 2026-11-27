#!/usr/bin/env bash
# Setup helper: install-node — bundles the Node install into one idempotent
# script so /new-setup can run it without needing `curl | sudo -E bash -` in
# the allowlist (that pattern is inherently unmatchable — bash reads from
# stdin, so pre-approval can't inspect what's being executed).
#
# The script itself is the allowlisted unit; the pipes and sudo live inside
# it. Pure bash by design — runs before Node exists on the host.
set -euo pipefail

# shellcheck source=setup/lib/node-version.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/node-version.sh"

echo "=== NANOCLAW SETUP: INSTALL_NODE ==="

NODE_LINE=22
CURRENT_NODE=""
if command -v node >/dev/null 2>&1; then
  CURRENT_NODE="$(command -v node)"
  CURRENT_VERSION="$(node --version)"
  if node_meets_minimum "$(node --version)"; then
    echo "STATUS: already-installed"
    echo "NODE_VERSION: $(node --version)"
    echo "=== END ==="
    exit 0
  fi
  if ! NODE_LINE="$(node_install_line "$(node --version)")"; then
    echo "STATUS: failed"
    echo "ERROR: $(node_minimum_message "$(node --version)" "$(command -v node)") Switch to one of these, then re-run."
    echo "=== END ==="
    exit 1
  fi
  # The system package install (NodeSource apt, zypper) replaces only the system
  # Node; one from a version manager (nvm, fnm, volta, asdf) would stay first on
  # PATH after a sudo install.
  if [ "$(uname -s)" = Linux ] && ! command -v uvx >/dev/null 2>&1 && ! node_from_apt "$CURRENT_NODE"; then
    echo "STATUS: failed"
    echo "ERROR: $(node_minimum_message "$CURRENT_VERSION" "$CURRENT_NODE") Update Node in your version manager to $(node_line_minimum "$NODE_LINE") or newer, then re-run setup."
    echo "=== END ==="
    exit 1
  fi
  echo "STEP: upgrade-node"
fi

if command -v uvx >/dev/null 2>&1; then
  echo "STEP: uvx-nodeenv"
  uvx nodeenv --force -n lts ~/node
  mkdir -p ~/.local/bin
  ln -sf ~/node/bin/node ~/.local/bin/node
  ln -sf ~/node/bin/npm ~/.local/bin/npm
  ln -sf ~/node/bin/npx ~/.local/bin/npx
  ln -sf ~/node/bin/pnpm ~/.local/bin/pnpm
  export PATH="$HOME/.local/bin:$PATH"
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
      export PATH="$(brew --prefix node@22)/bin:$PATH"
      case "$CURRENT_NODE" in
        "" | "$(brew --prefix node@22)"/*) ;;
        *) echo "NOTE: NanoClaw will use Homebrew's node@22. Your own node ($CURRENT_NODE) stays on $CURRENT_VERSION until you update it, e.g. brew upgrade node." ;;
      esac
      ;;
    Linux)
      # Pick the package manager from /etc/os-release. Subshell so its vars
      # (ID, VERSION, ...) don't leak into this script.
      DISTRO_IDS="$( . /etc/os-release 2>/dev/null && echo "${ID_LIKE:-} ${ID:-}" )"
      case " $DISTRO_IDS " in
        *" debian "* | *" ubuntu "*)
          echo "STEP: nodesource-setup"
          curl -fsSL "https://deb.nodesource.com/setup_${NODE_LINE}.x" | sudo -E /bin/bash -
          echo "STEP: apt-install-nodejs"
          sudo apt-get install -y nodejs
          ;;
        *" suse "* | *" opensuse "* | *" sles "*)
          # openSUSE's own repos ship versioned packages (nodejs22, nodejs24,
          # ...) side by side; nodejs24 clears NODE_MINIMUMS. npm comes from the
          # matching npmNN package. No third-party repo, so no curl | sudo.
          # If your release's own repos carry no Node that meets the minimum
          # (e.g. Leap 15.6), see which devel repositories do:
          # https://build.opensuse.org/project/show/devel:languages:nodejs
          SUSE_NODE_LINE=24
          echo "STEP: zypper-install-nodejs"
          sudo zypper --non-interactive install "nodejs${SUSE_NODE_LINE}" "npm${SUSE_NODE_LINE}"
          ;;
        # RHEL family: kept disabled until someone can test it. NodeSource's RPM
        # repo targets dnf/yum.
        # *" rhel "* | *" fedora "* | *" centos "*)
        #   echo "STEP: nodesource-setup"
        #   curl -fsSL "https://rpm.nodesource.com/setup_${NODE_LINE}.x" | sudo -E /bin/bash -
        #   echo "STEP: dnf-install-nodejs"
        #   sudo dnf install -y nodejs
        #   ;;
        *)
          echo "STATUS: failed"
          echo "ERROR: No automatic Node install for this Linux distro (${DISTRO_IDS# }). Debian/Ubuntu and openSUSE are supported. Install Node $(node_line_minimum "$NODE_LINE") or newer with your package manager, nvm, fnm or uv, then re-run."
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

# The install can land behind another Node on PATH, or the mirror can lag.
if ! node_meets_minimum "$(node --version)"; then
  echo "STATUS: failed"
  echo "ERROR: $(node_minimum_message "$(node --version)" "$(command -v node)") Update it, then re-run."
  echo "=== END ==="
  exit 1
fi

echo "STATUS: installed"
echo "NODE_VERSION: $(node --version)"
echo "=== END ==="
