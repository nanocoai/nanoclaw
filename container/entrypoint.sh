#!/bin/bash
set -euo pipefail

input_path="/tmp/input.json"
health_json=""
sidecar_pid=""
runner_pid=""

cleanup() {
    if [ -n "$health_json" ]; then
        rm -f "$health_json"
    fi
    if [ -n "$runner_pid" ] && kill -0 "$runner_pid" >/dev/null 2>&1; then
        kill "$runner_pid" >/dev/null 2>&1 || true
        wait "$runner_pid" >/dev/null 2>&1 || true
    fi
    if [ -n "$sidecar_pid" ] && kill -0 "$sidecar_pid" >/dev/null 2>&1; then
        kill "$sidecar_pid" >/dev/null 2>&1 || true
        wait "$sidecar_pid" >/dev/null 2>&1 || true
    fi
}

terminate() {
    cleanup
    exit 143
}

trap cleanup EXIT
trap terminate INT TERM

if [ "${CF_FETCH_SIDECAR_ENABLED:-1}" != "0" ]; then
    sidecar_no_proxy="127.0.0.1,localhost,::1"
    if [ -n "${NO_PROXY:-}" ]; then
        sidecar_no_proxy="${NO_PROXY},${sidecar_no_proxy}"
    fi
    env \
        -u HTTP_PROXY \
        -u HTTPS_PROXY \
        -u ALL_PROXY \
        -u http_proxy \
        -u https_proxy \
        -u all_proxy \
        NO_PROXY="$sidecar_no_proxy" \
        no_proxy="$sidecar_no_proxy" \
        python3 /opt/cf-fetch-server/server.py >&2 &
    sidecar_pid="$!"

    timeout_s="${CF_FETCH_SIDECAR_STARTUP_TIMEOUT:-75}"
    deadline=$((SECONDS + timeout_s))
    health_url="${CF_FETCH_SERVER_HEALTH_URL:-http://127.0.0.1:${CF_FETCH_SERVER_PORT:-8765}/healthz}"
    health_json="$(mktemp /tmp/cf-fetch-health.XXXXXX.json)"
    until curl -fsS "$health_url" > "$health_json" 2>/dev/null; do
        if ! kill -0 "$sidecar_pid" >/dev/null 2>&1; then
            wait "$sidecar_pid" || true
            echo "cf-fetch-server exited before health check passed" >&2
            exit 1
        fi
        if [ "$SECONDS" -ge "$deadline" ]; then
            echo "timed out waiting for cf-fetch-server health" >&2
            exit 1
        fi
        sleep 1
    done

    python3 - "$health_json" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    health = json.load(handle)

if health.get("backend") != "nodriver" or health.get("browser_ready") is not True:
    print(
        "cf-fetch-server health did not report nodriver readiness: "
        f"backend={health.get('backend')!r} "
        f"browser_ready={health.get('browser_ready')!r}",
        file=sys.stderr,
    )
    sys.exit(1)
PY
fi

cat > "$input_path"

bun run /app/src/index.ts < "$input_path" &
runner_pid="$!"

set +e
wait "$runner_pid"
status="$?"
set -e

exit "$status"
