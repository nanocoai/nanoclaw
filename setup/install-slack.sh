#!/usr/bin/env bash
# Setup helper: install-slack — bundles the preflight + install commands
# from the /add-slack skill into one idempotent script so /new-setup can
# run them programmatically before continuing to credentials.
#
# Copies the Slack adapter in from the `channels` branch; appends the
# self-registration import; installs the pinned @chat-adapter/slack package;
# builds. All steps are safe to re-run.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "=== NANOCLAW SETUP: INSTALL_SLACK ==="

needs_install=false
[[ -f src/channels/slack.ts ]] || needs_install=true
[[ -f container/skills/slack-formatting/SKILL.md ]] || needs_install=true
grep -q "import './slack.js';" src/channels/index.ts || needs_install=true
grep -q '"@chat-adapter/slack"' package.json || needs_install=true
[[ -d node_modules/@chat-adapter/slack ]] || needs_install=true

if ! $needs_install; then
  echo "STATUS: already-installed"
  echo "=== END ==="
  exit 0
fi

echo "STEP: fetch-channels-branch"
git fetch origin channels

echo "STEP: copy-files"
git show origin/channels:src/channels/slack.ts > src/channels/slack.ts
mkdir -p container/skills/slack-formatting
git show origin/channels:container/skills/slack-formatting/SKILL.md > container/skills/slack-formatting/SKILL.md

echo "STEP: register-import"
if ! grep -q "import './slack.js';" src/channels/index.ts; then
  printf "import './slack.js';\n" >> src/channels/index.ts
fi

echo "STEP: pnpm-install"
pnpm install @chat-adapter/slack@4.29.0

echo "STEP: pnpm-build"
pnpm run build

echo "STATUS: installed"
echo "=== END ==="
