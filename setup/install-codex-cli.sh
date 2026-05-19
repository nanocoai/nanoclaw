#!/usr/bin/env bash
set -euo pipefail

CODEX_VERSION="${CODEX_VERSION:-0.124.0}"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required before installing Codex CLI" >&2
  exit 1
fi

pnpm install -g "@openai/codex@${CODEX_VERSION}"
