#!/bin/sh
set -eu

source_path=src/cli/stdin-json.ts
target_path=container/agent-runner/src/cli/stdin-json.ts

if [ "${1:-}" = "--check" ]; then
  cmp -s "$source_path" "$target_path" || {
    echo "$target_path is stale; run pnpm stdin-json:generate" >&2
    exit 1
  }
else
  cp "$source_path" "$target_path"
fi
