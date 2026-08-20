#!/usr/bin/env bash
# Smoke test against a running clidash instance (run on the VM after deploy).
# Usage: ./test/smoke.sh [base-url]   (default http://127.0.0.1:4690)
set -euo pipefail
BASE="${1:-http://127.0.0.1:4690}"

check() {
  local label="$1" url="$2" pattern="$3"
  if curl -fsS --max-time 60 "$url" | grep -q "$pattern"; then
    echo "OK   $label"
  else
    echo "FAIL $label ($url did not match $pattern)"
    exit 1
  fi
}

# Discovery + one real resource table prove the CLI is reachable (these are the
# checks that fail when the NanoClaw host is not running).
check "/api/clis"            "$BASE/api/clis"            '"resources"'
check "/api/r/ncl/groups"    "$BASE/api/r/ncl/groups"    '"ok":true'
check "/api/r/ncl/sessions"  "$BASE/api/r/ncl/sessions"  '"ok":true'
# The three panels that read the filesystem rather than the CLI.
check "/api/activity"        "$BASE/api/activity"        '"ok":true'
check "/api/docs"            "$BASE/api/docs"            '"collections"'
check "/api/logs"            "$BASE/api/logs"            '"files"'
check "GET / (static UI)"    "$BASE/"                    'clidash'
echo "smoke: all good"
