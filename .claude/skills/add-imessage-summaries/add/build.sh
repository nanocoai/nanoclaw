#!/bin/bash
# Builds the release binaries (what install.sh installs) and a test build.
# Run as yourself from the NanoClaw project root. Output: dist/imsg-reader/ (or $BUILD_DIR).
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
OUT="${BUILD_DIR:-$PWD/dist/imsg-reader}"
[[ $EUID -ne 0 ]] || { echo "Build as yourself, not with sudo." >&2; exit 1; }
mkdir -p "$OUT/release" "$OUT/test"
SHARED=("$SRC"/Sources/Shared/*.swift)

swiftc -O -o "$OUT/release/imsg-reader" "${SHARED[@]}" "$SRC"/Sources/Reader/*.swift
swiftc -O -o "$OUT/release/imsg-reader-config" "${SHARED[@]}" "$SRC"/Sources/ConfigTool/*.swift
swiftc -O -D TESTING -o "$OUT/test/imsg-reader" "${SHARED[@]}" "$SRC"/Sources/Reader/*.swift

# Ad-hoc signature with the hardened runtime: no debugger attach, no injected libraries,
# and macOS ties the Full Disk Access grant to this exact build.
codesign -s - -f -o runtime --identifier com.nanoclaw.imsg-reader "$OUT/release/imsg-reader"
codesign -s - -f -o runtime --identifier com.nanoclaw.imsg-reader-config "$OUT/release/imsg-reader-config"
codesign -s - -f -o runtime --identifier com.nanoclaw.imsg-reader.test "$OUT/test/imsg-reader"

shasum -a 256 "$OUT/release/imsg-reader" "$OUT/release/imsg-reader-config"
