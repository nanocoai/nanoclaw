#!/usr/bin/env bash
# Setup helper: add-imessage-cloud — fetches the native iMessage (Photon)
# adapter from the `channels` branch, wires its self-registration import,
# installs the pinned spectrum-ts runtime, and builds. Idempotent — safe to
# re-run.
#
# Credentials (PHOTON_PROJECT_ID / PHOTON_PROJECT_SECRET) are written separately
# by the device-login wizard (scripts/photon-setup.ts), so this script asks for
# none. Mirrors the /add-imessage-cloud skill so setup:auto can run it
# programmatically before continuing to the service restart + wiring.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Keep in sync with .claude/skills/add-imessage-cloud/SKILL.md.
SPECTRUM_SDK="spectrum-ts@8.0.0"

# Resolve which remote carries the channels branch — handles forks where
# upstream lives on a different remote than `origin`.
# shellcheck source=setup/lib/channels-remote.sh
source "$PROJECT_ROOT/setup/lib/channels-remote.sh"
CHANNELS_REMOTE=$(resolve_channels_remote)
CHANNELS_BRANCH="${CHANNELS_REMOTE}/channels"

echo "=== NANOCLAW SETUP: ADD_IMESSAGE_CLOUD ==="

needs_install=false
[[ -f src/channels/imessage-cloud.ts ]] || needs_install=true
grep -q "^import './imessage-cloud.js';" src/channels/index.ts 2>/dev/null || needs_install=true
grep -q '"spectrum-ts"' package.json || needs_install=true

if ! $needs_install; then
  echo "STATUS: already-installed"
  echo "=== END ==="
  exit 0
fi

echo "STEP: fetch-channels-branch"
git fetch "$CHANNELS_REMOTE" channels

echo "STEP: copy-files"
git show "${CHANNELS_BRANCH}:src/channels/imessage-cloud.ts" > src/channels/imessage-cloud.ts
git show "${CHANNELS_BRANCH}:src/channels/imessage-cloud-registration.test.ts" > src/channels/imessage-cloud-registration.test.ts

echo "STEP: register-import"
if ! grep -q "^import './imessage-cloud.js';" src/channels/index.ts; then
  printf "import './imessage-cloud.js';\n" >> src/channels/index.ts
fi

echo "STEP: pnpm-install"
pnpm install "${SPECTRUM_SDK}"

echo "STEP: pnpm-build"
pnpm run build

echo "STATUS: installed"
echo "=== END ==="
