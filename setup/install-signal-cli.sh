#!/usr/bin/env bash
# install-signal-cli.sh — auto-install signal-cli on the host.
#
# NanoClaw needs `signal-cli` on PATH to talk to Signal. Picks the right
# install method per platform:
#   macOS  → `brew install signal-cli` (bottled, no Java needed)
#   Linux  → download latest native binary from GitHub releases to
#            ~/.local/bin/signal-cli (no Java, no sudo)
#
# Emits the standard NanoClaw STATUS block on success or failure so the
# `runQuietChild` driver can parse the outcome.

set -euo pipefail

VERSION="0.14.3"
INSTALL_DIR="${HOME}/.local/bin"

emit_status() {
  local status=$1 error=${2:-}
  echo "=== NANOCLAW SETUP: INSTALL_SIGNAL_CLI ==="
  echo "STATUS: ${status}"
  [ -n "$error" ] && echo "ERROR: ${error}"
  echo "=== END ==="
}

log() { echo "[install-signal-cli] $*" >&2; }

uname_s=$(uname)

if [[ "${uname_s}" == "Darwin" ]]; then
  if ! command -v brew >/dev/null 2>&1; then
    emit_status failed "homebrew_not_installed"
    exit 1
  fi
  log "Installing signal-cli via Homebrew…"
  brew install signal-cli >&2 || {
    emit_status failed "brew_install_failed"
    exit 1
  }
  emit_status success
  exit 0
fi

if [[ "${uname_s}" != "Linux" ]]; then
  emit_status failed "unsupported_platform_${uname_s}"
  exit 1
fi

# Linux native build (no Java required) → ~/.local/bin/signal-cli.
URL="https://github.com/AsamK/signal-cli/releases/download/v${VERSION}/signal-cli-${VERSION}-Linux-native.tar.gz"
TARBALL=$(mktemp -t signal-cli.XXXXXX.tar.gz)

log "Downloading signal-cli v${VERSION} (~96MB)…"
if ! curl -fLsS -o "${TARBALL}" "${URL}"; then
  rm -f "${TARBALL}"
  emit_status failed "download_failed"
  exit 1
fi

log "Extracting…"
EXTRACT_DIR=$(mktemp -d)
if ! tar -xzf "${TARBALL}" -C "${EXTRACT_DIR}"; then
  rm -rf "${TARBALL}" "${EXTRACT_DIR}"
  emit_status failed "extract_failed"
  exit 1
fi

mkdir -p "${INSTALL_DIR}"
log "Installing to ${INSTALL_DIR}/signal-cli…"
if ! mv "${EXTRACT_DIR}/signal-cli" "${INSTALL_DIR}/signal-cli"; then
  rm -rf "${TARBALL}" "${EXTRACT_DIR}"
  emit_status failed "install_failed"
  exit 1
fi
chmod +x "${INSTALL_DIR}/signal-cli"
rm -rf "${TARBALL}" "${EXTRACT_DIR}"

emit_status success
