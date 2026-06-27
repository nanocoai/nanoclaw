#!/usr/bin/env bash
set -euo pipefail

APP_DIR=/app
cd "$APP_DIR"

# 1. Materialize .env from injected secrets (code reads the FILE, not process.env).
echo "[entrypoint] writing .env from environment"
{
  [ -n "${ANTHROPIC_API_KEY:-}" ] && echo "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}"
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && echo "TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}"
  [ -n "${ASSISTANT_NAME:-}" ] && echo "ASSISTANT_NAME=${ASSISTANT_NAME}"
} > "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"

# Sync non-secret env for agent containers (per add-telegram skill convention).
mkdir -p "$APP_DIR/data/env"
cp "$APP_DIR/.env" "$APP_DIR/data/env/env"

# 2. Start the inner Docker daemon.
echo "[entrypoint] starting dockerd"
# overlay2 needs an overlayfs-capable backing FS; set DOCKERD_FLAGS=--storage-driver=vfs
# via the environment if the kernel/volume can't do overlay2.
dockerd ${DOCKERD_FLAGS:-} >/var/log/dockerd.log 2>&1 &

echo "[entrypoint] waiting for dockerd"
for i in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then
    echo "[entrypoint] dockerd is up"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "[entrypoint] FATAL: dockerd did not become ready in 60s" >&2
    cat /var/log/dockerd.log >&2 || true
    exit 1
  fi
  sleep 1
done

# 3. Build the agent image if missing (app does NOT build it at runtime).
if ! docker image inspect nanoclaw-agent:latest >/dev/null 2>&1; then
  echo "[entrypoint] building nanoclaw-agent:latest (first boot, slow)"
  ./container/build.sh
else
  echo "[entrypoint] nanoclaw-agent:latest already present"
fi

# 4. Run the orchestrator as the final process (correct signal handling).
echo "[entrypoint] starting nanoclaw"
exec node "$APP_DIR/dist/index.js"
