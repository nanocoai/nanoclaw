#!/usr/bin/env bash
# Setup helper: install-docker — bundles Docker install into one idempotent
# script so /new-setup can run it without needing `curl | sh` in the allowlist
# (pipelines split at matching time, and `sh` receiving stdin can't be
# pre-approved safely).
#
# The script itself is the allowlisted unit; the pipes and sudo live inside
# it. Starting the daemon (after install) stays separate — `open -a Docker`
# and `sudo systemctl start docker` are already in the allowlist.
set -euo pipefail

echo "=== NANOCLAW SETUP: INSTALL_DOCKER ==="

if command -v docker >/dev/null 2>&1; then
  echo "STATUS: already-installed"
  echo "DOCKER_VERSION: $(docker --version 2>/dev/null || echo unknown)"
  echo "=== END ==="
  exit 0
fi

case "$(uname -s)" in
  Darwin)
    echo "STEP: brew-install-docker"
    if ! command -v brew >/dev/null 2>&1; then
      echo "STATUS: failed"
      echo "ERROR: Homebrew not installed. Install brew first (https://brew.sh) then re-run."
      echo "=== END ==="
      exit 1
    fi
    brew install --cask docker
    ;;
  Linux)
    # Non-interactive apt: setup pipes this script's output to a log, so an
    # interactive prompt is invisible and hangs the whole run. get.docker.com
    # drives apt underneath, and needrestart's post-install whiptail dialog
    # blocks on stdin even when nobody can see it (#2514) —
    # NEEDRESTART_SUSPEND defers it; DEBIAN_FRONTEND silences the rest.
    export DEBIAN_FRONTEND=noninteractive
    export NEEDRESTART_SUSPEND=1
    echo "STEP: docker-get-script"
    curl -fsSL https://get.docker.com | sh
    echo "STEP: usermod-docker-group"
    sudo usermod -aG docker "$USER"
    echo "NOTE: you may need to log out and back in for docker group membership to take effect"
    ;;
  *)
    echo "STATUS: failed"
    echo "ERROR: Unsupported platform: $(uname -s)"
    echo "=== END ==="
    exit 1
    ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  echo "STATUS: failed"
  echo "ERROR: docker not found on PATH after install"
  echo "=== END ==="
  exit 1
fi

echo "STATUS: installed"
echo "DOCKER_VERSION: $(docker --version 2>/dev/null || echo unknown)"
echo "=== END ==="
