#!/usr/bin/env bash
# The uninstaller lives in the setup driver now (setup/uninstall/).
# Translate the short flags the old bash uninstaller accepted.
ARGS=()
for arg in "$@"; do
  case "$arg" in
    -n) ARGS+=("--dry-run") ;;
    -y) ARGS+=("--yes") ;;
    *)  ARGS+=("$arg") ;;
  esac
done
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/nanoclaw.sh" --uninstall "${ARGS[@]}"
