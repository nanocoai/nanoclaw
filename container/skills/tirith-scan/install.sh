#!/bin/bash
# Auto-install tirith to the persisted container path.
# SHA-256 checksum verified.
set -euo pipefail

TIRITH_DIR="/home/node/.claude/bin"
TIRITH_BIN="${TIRITH_DIR}/tirith"
REPO="sheeki03/tirith"

# Already installed
if [ -x "$TIRITH_BIN" ]; then
    exit 0
fi

# Detect platform
SYSTEM="$(uname -s)"
MACHINE="$(uname -m)"

case "$SYSTEM" in
    Darwin) PLAT="apple-darwin" ;;
    Linux)  PLAT="unknown-linux-gnu" ;;
    *)      echo "tirith: unsupported OS $SYSTEM" >&2; exit 1 ;;
esac

case "$MACHINE" in
    x86_64|amd64)   ARCH="x86_64" ;;
    aarch64|arm64)  ARCH="aarch64" ;;
    *)              echo "tirith: unsupported arch $MACHINE" >&2; exit 1 ;;
esac

TARGET="${ARCH}-${PLAT}"
ARCHIVE="tirith-${TARGET}.tar.gz"
BASE_URL="https://github.com/${REPO}/releases/latest/download"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# Download archive + checksums
curl -fsSL -o "${TMPDIR}/${ARCHIVE}" "${BASE_URL}/${ARCHIVE}"
curl -fsSL -o "${TMPDIR}/checksums.txt" "${BASE_URL}/checksums.txt"

# Verify SHA-256 checksum
EXPECTED="$(grep "  ${ARCHIVE}$" "${TMPDIR}/checksums.txt" | cut -d' ' -f1)"
if [ -z "$EXPECTED" ]; then
    echo "tirith: no checksum entry for ${ARCHIVE}" >&2
    exit 1
fi

ACTUAL="$(shasum -a 256 "${TMPDIR}/${ARCHIVE}" | cut -d' ' -f1)"
if [ "$ACTUAL" != "$EXPECTED" ]; then
    echo "tirith: checksum mismatch (expected ${EXPECTED}, got ${ACTUAL})" >&2
    exit 1
fi

# Extract and install
mkdir -p "$TIRITH_DIR"
tar xzf "${TMPDIR}/${ARCHIVE}" -C "$TMPDIR"
EXTRACTED="$(find "$TMPDIR" -name tirith -type f -perm +111 | head -1)"
if [ -z "$EXTRACTED" ]; then
    # Try without perm check (some tar implementations)
    EXTRACTED="$(find "$TMPDIR" -name tirith -type f | head -1)"
fi
if [ -z "$EXTRACTED" ]; then
    echo "tirith: binary not found in archive" >&2
    exit 1
fi

cp "$EXTRACTED" "$TIRITH_BIN"
chmod +x "$TIRITH_BIN"
echo "tirith installed to ${TIRITH_BIN} (SHA-256 verified)" >&2
