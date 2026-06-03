#!/bin/bash
# Build the NanoClaw Squid container image.
#
# Reads no env flags today; if we ever pin a different Squid version per
# install, this is the place to handle it.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$SCRIPT_DIR"

# shellcheck source=../../setup/lib/install-slug.sh
source "$PROJECT_ROOT/setup/lib/install-slug.sh"
AGENT_IMAGE_BASE="$(container_image_base)"
# Squid image is namespaced under the same install slug — `<slug>-squid`.
IMAGE_NAME="${AGENT_IMAGE_BASE}-squid"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

echo "Building NanoClaw Squid container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
