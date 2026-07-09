#!/usr/bin/env bash
# Setup helper: install-linear — bundles the preflight + install commands
# from the /add-linear skill into one idempotent script so /new-setup can
# run them programmatically before continuing to credentials.
#
# Copies the Linear adapter in from the `channels` branch; appends the
# self-registration import; patches src/channels/chat-sdk-bridge.ts to add
# catch-all forwarding (Linear OAuth apps can't be @-mentioned, so the
# onNewMention handler never fires — the bridge needs a catchAll path);
# installs the pinned @chat-adapter/linear package; builds. All steps are
# safe to re-run.
#
# Note: the bridge patch's onNewMessage handler passes `false` for isMention
# (current trunk signature requires the arg). The /add-linear SKILL's
# snippet omits the arg — this script uses the full signature so TypeScript
# builds cleanly.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "=== NANOCLAW SETUP: INSTALL_LINEAR ==="

needs_install=false
[[ -f src/channels/linear.ts ]] || needs_install=true
grep -q "import './linear.js';" src/channels/index.ts || needs_install=true
grep -q '"@chat-adapter/linear"' package.json || needs_install=true
[[ -d node_modules/@chat-adapter/linear ]] || needs_install=true
grep -q 'catchAll' src/channels/chat-sdk-bridge.ts || needs_install=true

if ! $needs_install; then
  echo "STATUS: already-installed"
  echo "=== END ==="
  exit 0
fi

echo "STEP: fetch-channels-branch"
git fetch origin channels

echo "STEP: copy-files"
git show origin/channels:src/channels/linear.ts > src/channels/linear.ts

echo "STEP: register-import"
if ! grep -q "import './linear.js';" src/channels/index.ts; then
  printf "import './linear.js';\n" >> src/channels/index.ts
fi

echo "STEP: patch-bridge-catchall-field"
if ! grep -q 'catchAll?: boolean;' src/channels/chat-sdk-bridge.ts; then
  awk '
    /^export interface ChatSdkBridgeConfig \{/ { in_iface = 1 }
    in_iface && /^\}/ && !inserted {
      print "  /**"
      print "   * Forward ALL messages in unsubscribed threads, not just @-mentions."
      print "   * Use for platforms where the bot identity can'\''t be @-mentioned (e.g."
      print "   * Linear OAuth apps). The thread is auto-subscribed on first message."
      print "   */"
      print "  catchAll?: boolean;"
      inserted = 1
      in_iface = 0
    }
    { print }
  ' src/channels/chat-sdk-bridge.ts > src/channels/chat-sdk-bridge.ts.tmp \
    && mv src/channels/chat-sdk-bridge.ts.tmp src/channels/chat-sdk-bridge.ts
fi

echo "STEP: patch-bridge-catchall-handler"
if ! grep -q 'if (config.catchAll) {' src/channels/chat-sdk-bridge.ts; then
  awk '
    /      \/\/ DMs — apply engage rules too/ && !inserted {
      print "      // Catch-all for platforms where @-mention isn'\''t possible (e.g. Linear"
      print "      // OAuth apps). Forward every unsubscribed message and auto-subscribe."
      print "      if (config.catchAll) {"
      print "        chat.onNewMessage(/.*/, async (thread, message) => {"
      print "          const channelId = adapter.channelIdFromThreadId(thread.id);"
      print "          await setupConfig.onInbound(channelId, thread.id, await messageToInbound(message, false));"
      print "          await thread.subscribe();"
      print "        });"
      print "      }"
      print ""
      inserted = 1
    }
    { print }
  ' src/channels/chat-sdk-bridge.ts > src/channels/chat-sdk-bridge.ts.tmp \
    && mv src/channels/chat-sdk-bridge.ts.tmp src/channels/chat-sdk-bridge.ts
fi

echo "STEP: pnpm-install"
pnpm install @chat-adapter/linear@4.29.0

echo "STEP: pnpm-build"
pnpm run build

echo "STATUS: installed"
echo "=== END ==="
