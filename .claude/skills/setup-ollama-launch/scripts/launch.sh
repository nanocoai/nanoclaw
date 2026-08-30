#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
cd "$PROJECT_ROOT"

if ! command -v pnpm >/dev/null 2>&1 || ! node -e "require('better-sqlite3')" >/dev/null 2>&1; then
  bash "$PROJECT_ROOT/setup.sh"
fi

export PATH="$HOME/.local/bin:$PATH"
# setup.sh selects the pinned package manager. Keep pnpm's self-switcher off for
# this process and every setup/skill subprocess; with a fresh HOME it otherwise
# recursively launches `pnpm add pnpm@<pin>` before NanoClaw can start.
export npm_config_manage_package_manager_versions=false
if ! command -v node >/dev/null 2>&1 && command -v brew >/dev/null 2>&1; then
  NODE22_PREFIX="$(brew --prefix node@22 2>/dev/null || true)"
  if [ -n "$NODE22_PREFIX" ]; then
    export PATH="$NODE22_PREFIX/bin:$PATH"
  fi
fi

if ! command -v pnpm >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  NPM_PREFIX="$(npm config get prefix 2>/dev/null)"
  if [ -n "$NPM_PREFIX" ] && [ -x "$NPM_PREFIX/bin/pnpm" ]; then
    export PATH="$NPM_PREFIX/bin:$PATH"
  fi
fi

command -v node >/dev/null 2>&1 || { echo "ollama-launch: node is unavailable after setup" >&2; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "ollama-launch: pnpm is unavailable after setup" >&2; exit 1; }

exec pnpm exec tsx "$SCRIPT_DIR/launch.ts" "$@"
