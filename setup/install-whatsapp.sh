#!/usr/bin/env bash
# Setup helper: install-whatsapp — bundles the preflight + install commands
# from the /add-whatsapp skill into one idempotent script so /new-setup can
# run them programmatically before continuing to QR/pairing-code auth.
#
# Copies the native Baileys WhatsApp adapter, its whatsapp-auth and groups
# setup steps in from the `channels` branch; appends the self-registration
# import; registers `groups` and `whatsapp-auth` entries in the setup STEPS
# map; installs the pinned @whiskeysockets/baileys + qrcode + pino packages;
# builds. All steps are safe to re-run. QR/pairing-code authentication
# stays in the skill — this script only handles the deterministic install.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "=== NANOCLAW SETUP: INSTALL_WHATSAPP ==="

CHANNEL_FILES=(
  src/channels/whatsapp.ts
  setup/whatsapp-auth.ts
  setup/groups.ts
  container/skills/whatsapp-formatting/SKILL.md
  container/skills/whatsapp-formatting/instructions.md
)

needs_install=false
for f in "${CHANNEL_FILES[@]}"; do
  [[ -f "$f" ]] || needs_install=true
done
grep -q "import './whatsapp.js';" src/channels/index.ts || needs_install=true
grep -q "groups: " setup/index.ts || needs_install=true
grep -q "'whatsapp-auth':" setup/index.ts || needs_install=true
grep -q '"@whiskeysockets/baileys"' package.json || needs_install=true
grep -q '"qrcode"' package.json || needs_install=true
grep -q '"pino"' package.json || needs_install=true
[[ -d node_modules/@whiskeysockets/baileys ]] || needs_install=true

if ! $needs_install; then
  echo "STATUS: already-installed"
  echo "=== END ==="
  exit 0
fi

echo "STEP: fetch-channels-branch"
git fetch origin channels

echo "STEP: copy-files"
for f in "${CHANNEL_FILES[@]}"; do
  mkdir -p "$(dirname "$f")"
  git show "origin/channels:$f" > "$f"
done

echo "STEP: register-import"
if ! grep -q "import './whatsapp.js';" src/channels/index.ts; then
  printf "import './whatsapp.js';\n" >> src/channels/index.ts
fi

echo "STEP: register-setup-steps"
if ! grep -q "'whatsapp-auth':" setup/index.ts; then
  awk '
    { print }
    /register: \(\) => import/ && !inserted {
      print "  groups: () => import('\''./groups.js'\''),"
      print "  '\''whatsapp-auth'\'': () => import('\''./whatsapp-auth.js'\''),"
      inserted = 1
    }
  ' setup/index.ts > setup/index.ts.tmp && mv setup/index.ts.tmp setup/index.ts
fi

echo "STEP: pnpm-install"
pnpm install @whiskeysockets/baileys@7.0.0-rc.9 qrcode@1.5.4 @types/qrcode@1.5.6 pino@9.6.0

echo "STEP: pnpm-build"
pnpm run build

echo "STATUS: installed"
echo "=== END ==="
