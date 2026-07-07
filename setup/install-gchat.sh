#!/usr/bin/env bash
# Setup helper: install-gchat — bundles the preflight + install commands
# from the /add-gchat skill into one idempotent script so /new-setup can
# run them programmatically before continuing to credentials.
#
# Copies the Google Chat adapter in from the `channels` branch; appends the
# self-registration import; installs the pinned @chat-adapter/gchat package;
# builds. All steps are safe to re-run.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "=== NANOCLAW SETUP: INSTALL_GCHAT ==="

needs_install=false
[[ -f src/channels/gchat.ts ]] || needs_install=true
grep -q "import './gchat.js';" src/channels/index.ts || needs_install=true
grep -q '"@chat-adapter/gchat"' package.json || needs_install=true
[[ -d node_modules/@chat-adapter/gchat ]] || needs_install=true

if ! $needs_install; then
  echo "STATUS: already-installed"
  echo "=== END ==="
  exit 0
fi

echo "STEP: fetch-channels-branch"
git fetch origin channels

echo "STEP: copy-files"
git show origin/channels:src/channels/gchat.ts > src/channels/gchat.ts

echo "STEP: register-import"
if ! grep -q "import './gchat.js';" src/channels/index.ts; then
  printf "import './gchat.js';\n" >> src/channels/index.ts
fi

echo "STEP: pnpm-install"
pnpm install @chat-adapter/gchat@4.29.0

echo "STEP: pnpm-build"
pnpm run build

echo "STATUS: installed"
echo "=== END ==="
