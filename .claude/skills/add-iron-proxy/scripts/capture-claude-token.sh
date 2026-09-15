#!/usr/bin/env bash
set -euo pipefail

output=${1:?output path required}
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if ! command -v claude >/dev/null 2>&1; then
  bash "$script_dir/install-claude.sh"
  export PATH="$HOME/.local/bin:$PATH"
fi
command -v script >/dev/null || { echo "script(1) is required for Claude subscription sign-in." >&2; exit 1; }

capture=$(mktemp -t claude-setup-token.XXXXXX)
trap 'rm -f "$capture"' EXIT

echo "Complete the Claude sign-in flow. The credential will be stored only by Iron Proxy."
if script --version 2>/dev/null | grep -q util-linux; then
  script -q -c "claude setup-token" "$capture"
else
  script -q "$capture" claude setup-token
fi

token=$(pnpm exec tsx setup/lib/captured-token.ts claude "$capture" || true)
if [[ -z "$token" ]]; then
  echo "No Claude OAuth token was captured." >&2
  exit 1
fi
umask 077
printf %s "$token" > "$output"
echo "Claude subscription credential captured for Iron Proxy."
