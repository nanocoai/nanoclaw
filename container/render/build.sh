#!/bin/bash
# Build the standalone document-rendering image (Quarto + LaTeX + Chromium).
# Used by the host's `render` system-action handler via `docker run --rm`.
set -euo pipefail
cd "$(dirname "$0")"
IMAGE="${RENDER_IMAGE:-nanoclaw-render:latest}"
echo "Building $IMAGE ..."
docker build -t "$IMAGE" .
echo "Done: $IMAGE"
