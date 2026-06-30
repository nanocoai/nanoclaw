#!/usr/bin/env bash
# Versioned setup for Andy container_configs (FR-012). Run from nanoclaw-v2 root.
set -euo pipefail
NANOCLAW_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
AGENT_GROUP_ID="${AGENT_GROUP_ID:-ag-1782743582785-mmzfdy}"

cd "$NANOCLAW_ROOT"

echo "Updating container config for ${AGENT_GROUP_ID}..."
pnpm exec ncl groups config update \
  --id "$AGENT_GROUP_ID" \
  --provider opencode \
  --model deepseek/deepseek-v4-pro

pnpm exec ncl groups config add-package \
  --id "$AGENT_GROUP_ID" \
  --npm rss-parser@3.13.0

echo ""
echo "Current config:"
pnpm exec ncl groups config get --id "$AGENT_GROUP_ID"

echo ""
echo "Restart container to apply (rebuild if packages changed):"
echo "  pnpm exec ncl groups restart --id ${AGENT_GROUP_ID} --rebuild"
echo ""
echo "Ensure TZ=Asia/Shanghai in host environment."
