#!/bin/bash
# NanoClaw 安全重启脚本
# 用法: ./restart.sh
# 原理: launchctl kickstart -k 会优雅杀掉旧进程树并按 start.sh 重新拉起，
#       绝不手动 kill/pkill（会引发双实例或自杀死循环）。

set -e
LABEL="com.nanoclaw"
LOG="/Users/dajay/AI_Workspace/nanoclaw/logs/nanoclaw.log"

OLDPID=$(launchctl list | awk -v l="$LABEL" '$0 ~ l {print $1}')
echo "[restart] 旧主进程 PID: ${OLDPID:-无}"

echo "[restart] 正在重启 $LABEL ..."
launchctl kickstart -k "gui/$(id -u)/$LABEL"

# 等新进程起来（PID 变化即成功）
NEWPID=""
for i in $(seq 1 30); do
  sleep 1
  NEWPID=$(launchctl list | awk -v l="$LABEL" '$0 ~ l {print $1}')
  if [ -n "$NEWPID" ] && [ "$NEWPID" != "$OLDPID" ] && [ "$NEWPID" != "-" ]; then
    echo "[restart] 新主进程 PID: $NEWPID (等了 ${i}s)"
    break
  fi
done

if [ -z "$NEWPID" ] || [ "$NEWPID" = "$OLDPID" ] || [ "$NEWPID" = "-" ]; then
  echo "[restart] !!! 警告：PID 未变化，重启可能失败，检查日志: $LOG"
  exit 1
fi

echo "[restart] 完成。实时日志: tail -f $LOG"
