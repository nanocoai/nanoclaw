#!/bin/bash
# Build the NanoClaw agent container image.
#
# Usage: ./container/build.sh [pull] [tag]
#
# `pull` hands off to container/pull.sh, which acquires the image from a
# registry and retags it to the same local tag this script builds — the one
# thing the host ever looks at. See that script for the settings it reads.
#
# Reads one optional build flag from ../.env:
#   INSTALL_CJK_FONTS=true   — add Chinese/Japanese/Korean fonts (~200MB)
# setup/container.ts reads the same file, so both build paths stay in sync.
# Callers can also override by exporting INSTALL_CJK_FONTS directly.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SCRIPT_DIR"

# Derive the image name from the project root so two NanoClaw installs on the
# same host don't overwrite each other's `nanoclaw-agent:latest` tag. Matches
# setup/lib/install-slug.sh + src/install-slug.ts.
# shellcheck source=../setup/lib/install-slug.sh
source "$PROJECT_ROOT/setup/lib/install-slug.sh"
IMAGE_NAME="$(container_image_base)"

# Record which agent-runner lockfile the baked /app/node_modules came from.
# container/pull.sh recomputes this the same way and refuses an image whose
# label disagrees with the checkout — see the lock check there for why.
#
# Computed here rather than beside the build because the pinned path below has
# to compare it against the image's label to decide whether a rebuild is needed
# at all, and that decision happens before any build argument is assembled.
LOCK_FILE="$SCRIPT_DIR/agent-runner/bun.lock"
LOCK_SHA=""
if [ -f "$LOCK_FILE" ]; then
    if command -v shasum >/dev/null 2>&1; then
        LOCK_SHA="$(shasum -a 256 "$LOCK_FILE" | cut -d' ' -f1)"
    elif command -v sha256sum >/dev/null 2>&1; then
        LOCK_SHA="$(sha256sum "$LOCK_FILE" | cut -d' ' -f1)"
    fi
fi

# Subcommand shift. Has to sit between IMAGE_NAME (which needs PROJECT_ROOT
# above) and TAG (which takes the first positional): any earlier and the slug
# isn't derived yet, any later and `build.sh pull` is read as a tag named
# "pull". Everything after the subcommand still shifts down to $1, so
# `build.sh pull v2` keeps meaning the same tag it does on the build path.
PULL=""
while [ $# -gt 0 ]; do
    case "$1" in
        pull|--pull) PULL="true"; shift ;;
        build|--build) PULL="false"; shift ;;
        --) shift; break ;;
        *) break ;;
    esac
done

TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

# No explicit subcommand, on an install that pulls its image. Skills that add a
# runtime dependency land here — they append to cli-tools.json (or edit the
# Dockerfile) and then call this script bare, expecting a rebuild.
#
# A full rebuild would start from the public Node base and throw the published
# image away, so an install that added the Vercel CLI would lose every layer its
# publisher hardened. Overlay instead: one layer on top of the image already
# here, applying the tool manifest. The published bytes stay underneath.
#
# The exception is the agent-runner's own dependencies. /app/node_modules is
# baked into the base while /app/src is bind-mounted from this checkout at
# spawn, so a checkout whose bun.lock has moved genuinely needs a base built
# from itself and no overlay can fix it. That is the one case that still
# refuses, and the image's own lock label is what tells the two apart.
OVERLAY="false"
if [ -z "$PULL" ]; then
    HARDENED="${NANOCLAW_HARDENED_IMAGE:-}"
    if [ -z "$HARDENED" ] && [ -f "$PROJECT_ROOT/.env" ]; then
        HARDENED="$(grep '^NANOCLAW_HARDENED_IMAGE=' "$PROJECT_ROOT/.env" | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '[:space:]')"
    fi
    if [ "$(printf '%s' "${HARDENED:-false}" | tr '[:upper:]' '[:lower:]')" = "true" ]; then
        IMAGE_LOCK="$(${CONTAINER_RUNTIME} image inspect \
            --format '{{index .Config.Labels "dev.nanoclaw.agent-runner-lock-sha256"}}' \
            "${IMAGE_NAME}:${TAG}" 2>/dev/null || true)"
        if [ -n "$LOCK_SHA" ] && [ "$IMAGE_LOCK" = "$LOCK_SHA" ]; then
            OVERLAY="true"
            PULL="false"
        else
            echo "Refusing to build: this install pulls its agent image, and this checkout's" >&2
            echo "container/agent-runner/bun.lock does not match the image that is here." >&2
            echo "" >&2
            echo "  image:    ${IMAGE_LOCK:-<no image, or no label>}" >&2
            echo "  checkout: ${LOCK_SHA:-<could not compute>}" >&2
            echo "" >&2
            echo "The agent-runner's dependencies are baked into the image, so this one cannot" >&2
            echo "be layered over — it needs a base built for this checkout." >&2
            echo "" >&2
            echo "  ./container/build.sh pull    fetch an image published for this checkout" >&2
            echo "  ./container/build.sh build   build locally and leave the pulled-image path" >&2
            exit 3
        fi
    else
        PULL="false"
    fi
fi

# An explicit `build` on a pinned install is a decision, not a one-off. Record
# it, because the line above promises this "leaves the pulled-image path" and
# until now it did not: .env still said hardened, so the next bare build refused
# again and the next /update-nanoclaw would `pull` straight over the image just
# built. One command, one consistent end state.
#
# Excludes the overlay path, which also sets PULL=false but is the opposite
# decision: it keeps the published image and layers on it, so dropping the
# install off the pinned path there would be exactly wrong.
if [ "$PULL" = "false" ] && [ "$OVERLAY" = "false" ] && [ -f "$PROJECT_ROOT/.env" ]; then
    CURRENT="$(grep '^NANOCLAW_HARDENED_IMAGE=' "$PROJECT_ROOT/.env" | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
    if [ "$CURRENT" = "true" ]; then
        sed -i.bak 's/^NANOCLAW_HARDENED_IMAGE=.*/NANOCLAW_HARDENED_IMAGE=false/' "$PROJECT_ROOT/.env"
        rm -f "$PROJECT_ROOT/.env.bak"
        echo "This install now builds its own agent image (NANOCLAW_HARDENED_IMAGE=false)."
        echo "Sign in again, or set it back to true, to return to the pulled image."
    fi
fi

# Caller's env takes precedence; fall back to .env.
if [ -z "${INSTALL_CJK_FONTS:-}" ] && [ -f "../.env" ]; then
    INSTALL_CJK_FONTS="$(grep '^INSTALL_CJK_FONTS=' ../.env | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '[:space:]')"
fi

BUILD_ARGS=()
if [ "${INSTALL_CJK_FONTS:-false}" = "true" ]; then
    if [ "$PULL" = "true" ]; then
        # A pulled image ships whatever font set its publisher baked in; this
        # build-arg has nothing to act on.
        echo "CJK fonts: ignored — this install pulls its image instead of building it"
    else
        echo "CJK fonts: enabled (adds ~200MB)"
        BUILD_ARGS+=(--build-arg INSTALL_CJK_FONTS=true)
    fi
fi

if [ -n "$LOCK_SHA" ]; then
    BUILD_ARGS+=(--build-arg "AGENT_RUNNER_LOCK_SHA256=$LOCK_SHA")
fi

if [ "$PULL" = "true" ]; then
    echo "Pulling NanoClaw agent container image..."
    # Not exec'd: pull.sh runs as a child so `set -e` still carries its exit
    # code and the trailing notes below print on both paths.
    bash "$SCRIPT_DIR/pull.sh" "$TAG"
elif [ "$OVERLAY" = "true" ]; then
    echo "Adding tools to the published agent image..."
    echo "Image: ${IMAGE_NAME}:${TAG}"

    # One layer, re-applying the whole manifest rather than a computed delta:
    # `pnpm install -g` at an already-installed pinned version is a no-op, so
    # asking for all of them is both simpler and correct, and it means a skill
    # only has to add its entry to cli-tools.json.
    #
    # `image-source` is deliberately NOT overwritten — the published bytes
    # underneath are still exactly what the publisher hardened, and claiming
    # otherwise would be as wrong as the inverse. What changes is that some
    # tools on top were not part of that, which is what the new label records.
    OVERLAY_DOCKERFILE="$(mktemp)"
    trap 'rm -f "$OVERLAY_DOCKERFILE"' EXIT
    {
        echo "FROM ${IMAGE_NAME}:${TAG}"
        echo "USER root"
        echo "COPY cli-tools.json install-cli-tools.sh /tmp/"
        echo "RUN sh /tmp/install-cli-tools.sh /tmp/cli-tools.json && \\"
        echo "    rm -f /tmp/cli-tools.json /tmp/install-cli-tools.sh"
        echo "USER node"
        echo "LABEL dev.nanoclaw.unhardened-additions=\"cli-tools.json\""
    } > "$OVERLAY_DOCKERFILE"

    ${CONTAINER_RUNTIME} build -f "$OVERLAY_DOCKERFILE" -t "${IMAGE_NAME}:${TAG}" .
else
    echo "Building NanoClaw agent container image..."
    echo "Image: ${IMAGE_NAME}:${TAG}"

    ${CONTAINER_RUNTIME} build "${BUILD_ARGS[@]}" -t "${IMAGE_NAME}:${TAG}" .
fi

echo ""
if [ "$PULL" = "true" ]; then
    echo "Pull complete!"
elif [ "$OVERLAY" = "true" ]; then
    echo "Tools added."
    echo ""
    echo "The published image underneath is unchanged, so you keep its hardening in"
    echo "full. The tools just layered on top are a different matter: they were not"
    echo "part of that build, nobody scanned them, and they may carry known"
    echo "vulnerabilities of their own."
    echo ""
    echo "To have added dependencies hardened too: https://echo.ai"
else
    echo "Build complete!"
fi
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
