#!/usr/bin/env bash
# Operator runbook: enable WeChat channel, wire DM to Andy, register wechat-me destination.
#
# Prerequisites (manual):
#   - NanoClaw host running from this worktree root
#   - Another WeChat account has sent at least one message to the bot (creates messaging_groups row)
#   - QR login completed (data/wechat/auth.json exists) — see add-wechat skill
#
# Usage (from anywhere):
#   bash groups/cli-with-muyu/daily-news-agent/scripts/setup-wechat-destination.sh
#
# Or with explicit platform id after first inbound DM:
#   PLATFORM_ID=wechat:wxid_xxxxx bash groups/cli-with-muyu/daily-news-agent/scripts/setup-wechat-destination.sh
set -euo pipefail

NANOCLAW_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
AGENT_GROUP_ID="${AGENT_GROUP_ID:-ag-1782743582785-mmzfdy}"
LOCAL_NAME="${LOCAL_NAME:-wechat-me}"

cd "$NANOCLAW_ROOT"

echo "== Step 1: Enable WeChat channel in .env =="
echo "Add or set in ${NANOCLAW_ROOT}/.env:"
echo "  WECHAT_ENABLED=true"
echo ""
echo "Sync env into container data (if using containerized host):"
echo "  mkdir -p data/env && cp .env data/env/env"
echo ""
echo "Restart NanoClaw, scan QR from data/wechat/qr.txt or logs, confirm data/wechat/auth.json exists."
echo ""
read -r -p "Press Enter after QR login is complete..."

if [[ ! -f .env ]] || ! grep -qE '^WECHAT_ENABLED=true' .env 2>/dev/null; then
  echo "WARN: .env missing WECHAT_ENABLED=true — set it before restarting the host."
fi

echo ""
echo "== Step 2: Wire WeChat DM to Andy agent group =="
WIRE_ARGS=(--agent-group "$AGENT_GROUP_ID" --non-interactive)
if [[ -n "${PLATFORM_ID:-}" ]]; then
  WIRE_ARGS+=(--platform-id "$PLATFORM_ID")
fi
echo "Running: pnpm exec tsx .claude/skills/add-wechat/scripts/wire-dm.ts ${WIRE_ARGS[*]}"
pnpm exec tsx .claude/skills/add-wechat/scripts/wire-dm.ts "${WIRE_ARGS[@]}"

echo ""
echo "== Step 3: Resolve messaging group id (mg-id) =="
MG_ID="$(sqlite3 data/v2.db "
  SELECT mg.id
  FROM messaging_groups mg
  JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
  WHERE mg.channel_type = 'wechat' AND mga.agent_group_id = '${AGENT_GROUP_ID}'
  ORDER BY mga.created_at DESC
  LIMIT 1;
")"
if [[ -z "$MG_ID" ]]; then
  echo "ERROR: No wired WeChat messaging group found for ${AGENT_GROUP_ID}."
  echo "Send a message to the bot from another WeChat account, then re-run step 2."
  exit 1
fi
echo "Using messaging_groups.id: ${MG_ID}"

echo ""
echo "== Step 4: Register wechat-me destination =="
echo "Running: pnpm exec ncl destinations add --agent-group-id ${AGENT_GROUP_ID} --local-name ${LOCAL_NAME} --target-type channel --target-id ${MG_ID}"
pnpm exec ncl destinations add \
  --agent-group-id "$AGENT_GROUP_ID" \
  --local-name "$LOCAL_NAME" \
  --target-type channel \
  --target-id "$MG_ID"

echo ""
echo "== Verify =="
echo "  pnpm exec ncl destinations list --agent-group-id ${AGENT_GROUP_ID}"
pnpm exec ncl destinations list --agent-group-id "$AGENT_GROUP_ID"
echo ""
echo "Done. Agent can send_message(to=\"${LOCAL_NAME}\") to deliver to WeChat."
