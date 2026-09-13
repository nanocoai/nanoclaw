#!/usr/bin/env bash
# Setup helper: install-github — bundles the preflight + install commands
# from the /add-github skill into one idempotent script so /new-setup can
# run them programmatically before continuing to credentials.
#
# Copies the GitHub adapter in from the `channels` branch; appends the
# self-registration import; installs the pinned @chat-adapter/github package;
# builds. All steps are safe to re-run.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "=== NANOCLAW SETUP: INSTALL_GITHUB ==="

needs_install=false
[[ -f src/channels/github.ts ]] || needs_install=true
grep -q "import './github.js';" src/channels/index.ts || needs_install=true
grep -q '"@chat-adapter/github"' package.json || needs_install=true
[[ -d node_modules/@chat-adapter/github ]] || needs_install=true

if ! $needs_install; then
  echo "STATUS: already-installed"
  echo "=== END ==="
  exit 0
fi

echo "STEP: fetch-channels-branch"
git fetch origin '+refs/heads/channels:refs/remotes/origin/channels'

echo "STEP: copy-files"
# Publish only a complete Git result; a failed copy must remain retryable.
(
  [[ ! -d src/channels/github.ts ]] || {
    echo "ERROR: src/channels/github.ts is a directory; refusing to copy the adapter into it" >&2
    exit 1
  }
  nc_copy_dir="$(mktemp -d src/channels/.github.ts.XXXXXX)"
  trap 'rm -rf -- "$nc_copy_dir"' EXIT
  if [[ -f src/channels/github.ts ]]; then
    cp -p -- src/channels/github.ts "$nc_copy_dir/payload"
  fi
  git show refs/remotes/origin/channels:src/channels/github.ts > "$nc_copy_dir/payload"
  mv -- "$nc_copy_dir/payload" src/channels/github.ts
)

echo "STEP: register-import"
if ! grep -q "import './github.js';" src/channels/index.ts; then
  printf "import './github.js';\n" >> src/channels/index.ts
fi

echo "STEP: pnpm-install"
pnpm install @chat-adapter/github@4.35.0

echo "STEP: pnpm-build"
pnpm run build

echo "STATUS: installed"
echo "=== END ==="
