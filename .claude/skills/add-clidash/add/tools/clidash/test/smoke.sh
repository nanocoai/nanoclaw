#!/usr/bin/env bash
# Smoke test against a running clidash instance (run on the VM after deploy).
# Usage: ./test/smoke.sh [base-url]   (default http://127.0.0.1:4690)
set -euo pipefail
BASE="${1:-http://127.0.0.1:4690}"

check() {
  local label="$1" url="$2" pattern="$3"
  if curl -fsS --max-time 15 "$url" | grep -q "$pattern"; then
    echo "OK   $label"
  else
    echo "FAIL $label ($url did not match $pattern)"
    exit 1
  fi
}

check "/api/clis"             "$BASE/api/clis"             '"resources"'
check "/api/r/ncl/sessions"   "$BASE/api/r/ncl/sessions"   '"ok":true'
check "/api/view/ncl/overview" "$BASE/api/view/ncl/overview" '"ok":true'
check "GET / (static UI)"     "$BASE/"                     'clidash'
echo "smoke: all good"
