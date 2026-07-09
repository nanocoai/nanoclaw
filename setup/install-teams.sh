#!/usr/bin/env bash
# Setup helper: install-teams — bundles the preflight + install commands
# from the /add-teams skill into one idempotent script so /new-setup can
# run them programmatically before continuing to credentials.
#
# Copies the Teams adapter in from the `channels` branch; appends the
# self-registration import; installs the pinned @chat-adapter/teams package;
# builds. All steps are safe to re-run.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "=== NANOCLAW SETUP: INSTALL_TEAMS ==="

needs_install=false
[[ -f src/channels/teams.ts ]] || needs_install=true
grep -q "import './teams.js';" src/channels/index.ts || needs_install=true
grep -q '"@chat-adapter/teams"' package.json || needs_install=true
[[ -d node_modules/@chat-adapter/teams ]] || needs_install=true

if ! $needs_install; then
  echo "STATUS: already-installed"
  echo "=== END ==="
  exit 0
fi

echo "STEP: fetch-channels-branch"
git fetch origin channels

echo "STEP: copy-files"
git show origin/channels:src/channels/teams.ts > src/channels/teams.ts

echo "STEP: register-import"
if ! grep -q "import './teams.js';" src/channels/index.ts; then
  printf "import './teams.js';\n" >> src/channels/index.ts
fi

echo "STEP: pnpm-install"
pnpm install @chat-adapter/teams@4.29.0

echo "STEP: pnpm-build"
pnpm run build

echo "STATUS: installed"
echo "=== END ==="
