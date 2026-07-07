#!/usr/bin/env bash
# Setup helper: install-telegram — bundles the preflight + install commands
# from the /add-telegram skill into one idempotent script so /new-setup can
# run them programmatically before continuing to credentials and pairing.
#
# Copies the Telegram adapter, helpers, tests, and the pair-telegram setup
# step in from the `channels` branch; appends the self-registration import;
# registers the `pair-telegram` entry in the setup STEPS map; installs the
# pinned @chat-adapter/telegram package; builds. All steps are safe to re-run.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "=== NANOCLAW SETUP: INSTALL_TELEGRAM ==="

CHANNEL_FILES=(
  src/channels/telegram.ts
  src/channels/telegram-pairing.ts
  src/channels/telegram-pairing.test.ts
  src/channels/telegram-markdown-sanitize.ts
  src/channels/telegram-markdown-sanitize.test.ts
  setup/pair-telegram.ts
)

needs_install=false
for f in "${CHANNEL_FILES[@]}"; do
  [[ -f "$f" ]] || needs_install=true
done
grep -q "import './telegram.js';" src/channels/index.ts || needs_install=true
grep -q "'pair-telegram':" setup/index.ts || needs_install=true
grep -q '"@chat-adapter/telegram"' package.json || needs_install=true
[[ -d node_modules/@chat-adapter/telegram ]] || needs_install=true

if ! $needs_install; then
  echo "STATUS: already-installed"
  echo "=== END ==="
  exit 0
fi

echo "STEP: fetch-channels-branch"
git fetch origin channels

echo "STEP: copy-files"
for f in "${CHANNEL_FILES[@]}"; do
  git show "origin/channels:$f" > "$f"
done

echo "STEP: register-import"
if ! grep -q "import './telegram.js';" src/channels/index.ts; then
  printf "import './telegram.js';\n" >> src/channels/index.ts
fi

echo "STEP: register-setup-step"
if ! grep -q "'pair-telegram':" setup/index.ts; then
  awk '
    { print }
    /register: \(\) => import/ && !inserted {
      print "  '\''pair-telegram'\'': () => import('\''./pair-telegram.js'\''),"
      inserted = 1
    }
  ' setup/index.ts > setup/index.ts.tmp && mv setup/index.ts.tmp setup/index.ts
fi

echo "STEP: pnpm-install"
pnpm install @chat-adapter/telegram@4.29.0

echo "STEP: pnpm-build"
pnpm run build

echo "STATUS: installed"
echo "=== END ==="
