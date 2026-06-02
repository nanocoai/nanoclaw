#!/bin/bash
# NanoClaw 启动脚本 — 启动前自动修复 better-sqlite3 native binding

NODE="/Users/dajay/.nvm/versions/node/v22.22.0/bin/node"
DIR="/Users/dajay/AI_Workspace/nanoclaw"
BINDING="$DIR/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
BACKUP="$DIR/data/better_sqlite3.node.bak"

if [ ! -f "$BINDING" ]; then
  echo "[start.sh] better_sqlite3.node missing, restoring from backup..."
  mkdir -p "$(dirname "$BINDING")"
  cp "$BACKUP" "$BINDING"
  chmod +x "$BINDING"
  echo "[start.sh] restored."
fi

# Credential Proxy（cli-proxy-api，已废弃）已停用：interactive 模式改走 OneCLI 上游（HTTPS_PROXY → 10255），
# OneCLI 支持 opus-4-8 等新模型，cli-proxy-api(8317) 的 provider 映射不认 4.8。
# 如需恢复 cli-proxy-api，取消下面两行注释即可。
# export CREDENTIAL_PROXY_URL="http://localhost:8317"
# export CREDENTIAL_PROXY_API_KEY="oc-dog-666"

# 默认 cwd：未配置 group.customCwd 时的兜底（container-runner.ts:262）
# 主会话 session jsonl 历来存在 -Users-dajay-AI-Workspace-nine 项目 hash 下，缺这个
# env 时 SDK 会按 groups/<folder> 算 hash 找不到 jsonl，触发 "No conversation found" 死循环
export NANOCLAW_DEFAULT_CWD="/Users/dajay/AI_Workspace/nine"

exec "$NODE" "$DIR/dist/index.js"
