#!/bin/bash
# Build NanoClaw agent container image(s).
#
# Usage:
#   ./container/build.sh [tag]
#
# Builds the default image (container/Dockerfile → nanoclaw-agent:{tag}) plus
# any variant images found in subdirectories:
#   container/{name}/Dockerfile  →  nanoclaw-agent-{name}:{tag}
#   container/{name}/Containerfile  →  nanoclaw-agent-{name}:{tag}
#
# The build context for all images is the container/ directory, so variant
# Dockerfiles can COPY from agent-runner/ just like the default one.
#
# Override the container runtime via CONTAINER_RUNTIME (default: docker).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

# Directories that live inside container/ but are NOT image variants
SKIP_DIRS=("agent-runner" "skills")

build_image() {
  local dockerfile="$1"
  local image_name="$2"
  echo ""
  echo "Building ${image_name}:${TAG} (from ${dockerfile})..."
  ${CONTAINER_RUNTIME} build -t "${image_name}:${TAG}" -f "${dockerfile}" .
  echo "Built ${image_name}:${TAG}"
}

# --- Default image ---
build_image "Dockerfile" "nanoclaw-agent"

# --- Variant images ---
for dir in */; do
  dir="${dir%/}"

  # Skip non-image directories
  skip=false
  for s in "${SKIP_DIRS[@]}"; do
    [[ "$dir" == "$s" ]] && skip=true && break
  done
  $skip && continue

  if [[ -f "$dir/Dockerfile" ]]; then
    build_image "$dir/Dockerfile" "nanoclaw-agent-${dir}"
  elif [[ -f "$dir/Containerfile" ]]; then
    build_image "$dir/Containerfile" "nanoclaw-agent-${dir}"
  fi
done

echo ""
echo "All images built successfully."
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i nanoclaw-agent:${TAG}"
