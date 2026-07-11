#!/bin/bash

set -euo pipefail

REPO_ROOT="${1:-$(pwd)}"
DEPLOY_REF="${NANOCLAW_DEPLOY_REF:-origin/main}"

git -C "$REPO_ROOT" fetch origin main --quiet

if [ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=normal)" ]; then
  echo "[deploy-guard] 拒绝部署：工作树存在未提交改动。" >&2
  git -C "$REPO_ROOT" status --short >&2
  exit 1
fi

HEAD_SHA=$(git -C "$REPO_ROOT" rev-parse HEAD)
DEPLOY_SHA=$(git -C "$REPO_ROOT" rev-parse "$DEPLOY_REF")

if [ "$HEAD_SHA" != "$DEPLOY_SHA" ]; then
  echo "[deploy-guard] 拒绝部署：HEAD 与 $DEPLOY_REF 不一致。" >&2
  echo "[deploy-guard] HEAD=$HEAD_SHA" >&2
  echo "[deploy-guard] $DEPLOY_REF=$DEPLOY_SHA" >&2
  exit 1
fi

echo "[deploy-guard] 部署状态检查通过：$DEPLOY_REF ($HEAD_SHA)"
