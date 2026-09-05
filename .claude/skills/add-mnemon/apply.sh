#!/usr/bin/env bash
set -euo pipefail

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

if ! grep -q 'ARG MNEMON_VERSION' container/Dockerfile; then
  awk '
    /^# ---- Bun runtime/ && !added {
      print "# ---- mnemon — persistent agent memory ----------------------------------------"
      print "ARG MNEMON_VERSION=0.1.1"
      printf "%s%c\n", "RUN ARCH=$(dpkg --print-architecture) && ", 92
      printf "%s%c\n", "    curl -fsSL \"https://github.com/mnemon-dev/mnemon/releases/download/v${MNEMON_VERSION}/mnemon_${MNEMON_VERSION}_linux_${ARCH}.tar.gz\" ", 92
      printf "%s%c\n", "    | tar -xz -C /usr/local/bin mnemon && ", 92
      print "    chmod +x /usr/local/bin/mnemon"
      print ""
      print "ENV MNEMON_DATA_DIR=/home/node/.claude/mnemon"
      print ""
      added = 1
    }
    { print }
    END { if (!added) exit 1 }
  ' container/Dockerfile > "$tmp"
  cp "$tmp" container/Dockerfile
fi

if ! grep -q 'mnemon setup --target claude-code' container/entrypoint.sh; then
  awk '
    /^set -e$/ && !added {
      print
      print ""
      print "mnemon setup --target claude-code --yes --global >/dev/stderr 2>&1"
      added = 1
      next
    }
    { print }
    END { if (!added) exit 1 }
  ' container/entrypoint.sh > "$tmp"
  cp "$tmp" container/entrypoint.sh
fi
