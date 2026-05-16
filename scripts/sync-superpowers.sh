#!/bin/bash
# 从 superpowers 源码同步 skill 到 NanoClaw
# 用法: ./scripts/sync-superpowers.sh

set -euo pipefail

SUPERPOWERS_DIR="$HOME/AI_Workspace/superpowers/skills"
NANOCLAW_SKILLS="$HOME/AI_Workspace/nanoclaw/container/skills"

# 要同步的 skill 列表
SKILLS=(
  systematic-debugging
  verification-before-completion
  writing-plans
  test-driven-development
  receiving-code-review
  requesting-code-review
)

if [ ! -d "$SUPERPOWERS_DIR" ]; then
  echo "❌ superpowers 目录不存在: $SUPERPOWERS_DIR"
  exit 1
fi

# 先更新 superpowers 源码
echo "📦 更新 superpowers..."
cd "$HOME/AI_Workspace/superpowers"
git pull --quiet
echo "✅ superpowers 已更新到 $(git log --oneline -1)"

echo ""
echo "🔄 同步 skills..."
for skill in "${SKILLS[@]}"; do
  src="$SUPERPOWERS_DIR/$skill"
  dst="$NANOCLAW_SKILLS/$skill"
  if [ ! -d "$src" ]; then
    echo "⚠️  跳过 $skill (源不存在)"
    continue
  fi
  rm -rf "$dst"
  cp -r "$src" "$dst"
  echo "✅ $skill"
done

echo ""
echo "🎉 同步完成。重启 NanoClaw 新会话生效。"
