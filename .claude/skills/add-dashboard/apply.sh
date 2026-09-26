#!/usr/bin/env bash
set -euo pipefail

target=src/index.ts
grep -q "import('./dashboard-pusher.js')" "$target" && exit 0

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
awk '
  /  log\.info\('\''NanoClaw running'\''\);/ && !added {
    print "  // Dashboard (optional; no-ops without DASHBOARD_SECRET)"
    print "  const { startDashboard } = await import('\''./dashboard-pusher.js'\'');"
    print "  await startDashboard();"
    print ""
    added = 1
  }
  { print }
  END { if (!added) exit 1 }
' "$target" > "$tmp"
cp "$tmp" "$target"
