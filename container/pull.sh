#!/bin/bash
# Acquire the NanoClaw agent container image from a registry instead of building
# it here, then retag it to this install's local slug tag.
#
# The retag is the whole mechanism: nothing in src/ learns a registry exists. The
# host spawns `nanoclaw-agent-v2-<slug>:latest` exactly as it does after
# ./container/build.sh, and derived per-group images keep building with no network.
#
# Settings — caller's env wins, then ../.env, matching build.sh:
#
#   NANOCLAW_AGENT_IMAGE_REF        What to acquire. Pin by digest so the bytes
#                                   landing under the local tag are the ones you
#                                   chose. Falls back to the `agent-image` pin in
#                                   versions.json; refuses to guess without one.
#   NANOCLAW_ALLOW_UNLABELED_IMAGE  Accept an image with no agent-runner lock
#                                   label. Off by default — see the lock check.
#
# setup/lib/registry-state.ts mirrors that precedence; keep the two in lockstep.
#
# Auth is entirely the operator's existing `docker login`. This script holds no
# credentials and never prompts — it runs both under setup's step runner (stdin
# discarded) and under the Linux `sg docker` re-exec (real TTY), so a prompt
# would work in one path and hang forever in the other.
#
# Exits 2 when nothing is configured to acquire, 1 on any other failure.
#
# Usage: container/pull.sh [tag]      (tag defaults to latest)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SCRIPT_DIR"

# Same slug derivation as build.sh — the local tag has to be the one the host
# already spawns (src/config.ts CONTAINER_IMAGE).
# shellcheck source=../setup/lib/install-slug.sh
source "$PROJECT_ROOT/setup/lib/install-slug.sh"
IMAGE_NAME="$(container_image_base)"
TAG="${1:-latest}"
LOCAL_REF="${IMAGE_NAME}:${TAG}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

# Caller's env takes precedence; fall back to .env.
read_env_setting() {
    if [ ! -f "$PROJECT_ROOT/.env" ]; then
        return 0
    fi
    grep "^$1=" "$PROJECT_ROOT/.env" | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '[:space:]'
}

# The committed pin, last in the precedence chain. setup/lib/version-pins.ts
# reads the same file from the TypeScript side. versions.json is flat, one
# level, string values only — so grep is enough, and this script keeps working
# on a machine where setup hasn't installed node yet.
read_version_pin() {
    if [ ! -f "$PROJECT_ROOT/versions.json" ]; then
        return 0
    fi
    grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$PROJECT_ROOT/versions.json" \
        | head -n1 | sed 's/.*:[[:space:]]*"//; s/"$//'
}

# A per-platform pin: "agent-image": { "linux/amd64": "…", "linux/arm64": "…" }
# for a publisher that ships per-architecture references rather than one
# multi-arch index. Flatten first because the object spans lines, then pick the
# one platform out of it. Still no jq and no node, for the reason above.
read_version_pin_platform() {
    if [ ! -f "$PROJECT_ROOT/versions.json" ]; then
        return 0
    fi
    tr -d '\n' < "$PROJECT_ROOT/versions.json" \
        | grep -o "\"$1\"[[:space:]]*:[[:space:]]*{[^}]*}" \
        | head -n1 \
        | grep -o "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
        | head -n1 | sed 's/.*:[[:space:]]*"//; s/"$//'
}

# Which platforms such a pin declares — for the error when none is this one.
version_pin_platforms() {
    if [ ! -f "$PROJECT_ROOT/versions.json" ]; then
        return 0
    fi
    tr -d '\n' < "$PROJECT_ROOT/versions.json" \
        | grep -o "\"$1\"[[:space:]]*:[[:space:]]*{[^}]*}" \
        | head -n1 \
        | grep -o "\"[^\"]*\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
        | sed 's/[[:space:]]*:.*//; s/"//g' \
        | tr '\n' ' '
}

# Docker's architecture name for the daemon that will run the image, not the
# host CPU's — with Docker Desktop, a remote daemon, or a cross-architecture
# context the two differ, and the daemon is what actually executes.
# `setup/lib/registry-state.ts` resolves it the same way; if these disagree,
# --status compares against a pin the pull never used.
host_arch() {
    local a
    a="$(${CONTAINER_RUNTIME} version --format '{{.Server.Arch}}' 2>/dev/null || true)"
    if [ -n "$a" ]; then
        printf '%s' "$a"
        return 0
    fi
    # Daemon wouldn't say. uname's names are not Docker's.
    case "$(uname -m)" in
        x86_64|amd64) printf 'amd64' ;;
        aarch64|arm64) printf 'arm64' ;;
        *) printf '%s' "$(uname -m)" ;;
    esac
}

# sha256 of the agent-runner lockfile. container/build.sh computes this the
# same way and stamps it onto locally built images; keep the two in lockstep.
lock_sha256() {
    local f="$SCRIPT_DIR/agent-runner/bun.lock"
    if [ ! -f "$f" ]; then
        return 0
    fi
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$f" | cut -d' ' -f1
    elif command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$f" | cut -d' ' -f1
    fi
}

HOST_ARCH="$(host_arch)"
HOST_PLATFORM="linux/${HOST_ARCH}"

REF="${NANOCLAW_AGENT_IMAGE_REF:-}"
if [ -z "$REF" ]; then
    REF="$(read_env_setting NANOCLAW_AGENT_IMAGE_REF)"
fi
if [ -z "$REF" ]; then
    # A single reference covers a multi-arch index digest — docker resolves that
    # to this platform on its own — and a publisher that ships only one arch.
    REF="$(read_version_pin agent-image)"
fi
if [ -z "$REF" ]; then
    REF="$(read_version_pin_platform agent-image "$HOST_PLATFORM")"
    if [ -z "$REF" ]; then
        PIN_PLATFORMS="$(version_pin_platforms agent-image)"
        if [ -n "$PIN_PLATFORMS" ]; then
            echo "No agent-image reference for ${HOST_PLATFORM}." >&2
            echo "  versions.json pins: ${PIN_PLATFORMS}" >&2
            echo "" >&2
            echo "The pin ships per-architecture references and none is for this" >&2
            echo "daemon. Build locally with \`./container/build.sh build\`, or set" >&2
            echo "NANOCLAW_AGENT_IMAGE_REF to a reference for this architecture." >&2
            exit 1
        fi
    fi
fi
ALLOW_UNLABELED="${NANOCLAW_ALLOW_UNLABELED_IMAGE:-}"
if [ -z "$ALLOW_UNLABELED" ]; then
    ALLOW_UNLABELED="$(read_env_setting NANOCLAW_ALLOW_UNLABELED_IMAGE)"
fi

if [ -z "$REF" ]; then
    echo "No image reference configured — nothing to acquire." >&2
    echo "" >&2
    echo "Point NANOCLAW_AGENT_IMAGE_REF at the image, in the environment or in" >&2
    echo ".env, and make sure this machine can already reach it (\`docker login" >&2
    echo "<registry>\` if it needs credentials):" >&2
    echo "" >&2
    echo "  NANOCLAW_AGENT_IMAGE_REF=registry.example.com/nanoclaw/agent@sha256:<digest>" >&2
    echo "" >&2
    echo "A committed \"agent-image\" pin in versions.json serves the same purpose." >&2
    echo "Or drop NANOCLAW_HARDENED_IMAGE from .env to go back to local builds." >&2
    exit 2
fi

case "$REF" in
    *@sha256:*) ;;
    *)
        echo "Note: ${REF} is not digest-pinned."
        echo "  A mutable tag is fetched once and then never re-checked (see the guard"
        echo "  below), so what you run can drift from what the publisher serves."
        ;;
esac

# THE GUARD. `docker pull` has no offline cache-hit path — pulling a
# locally-present, registry-qualified ref with the registry unreachable fails
# outright, while `docker image inspect` on it succeeds. Without this, registry
# reachability becomes a hard dependency of every ./container/build.sh caller:
# ~15 /add-* skills, /update-nanoclaw and migrate-v2.sh.
if ${CONTAINER_RUNTIME} image inspect "$REF" >/dev/null 2>&1; then
    echo "Already present locally: ${REF}"
else
    echo "Pulling ${REF}..."
    # The pull nonce. `docker-credential-nanoclaw` refuses to mint unless
    # NANOCLAW_PULL_NONCE is set AND matches a 0600 file it can see, written
    # less than five minutes ago — so the credential is only obtainable for the
    # duration of a pull this script is actually running. It is not a boundary
    # against a same-uid attacker (that process can read both the variable and
    # the file, and the token itself); what it removes is the standing oracle,
    # where anything on the machine could mint a credential attributed to this
    # account at any moment. Setting it here is required: the helper hard-fails
    # without it, so a gated pull cannot succeed if this block is removed.
    #
    # Installs pulling from a registry they already `docker login`ed to never
    # reach the helper, and are unaffected.
    NONCE_DIR="${HOME}/.config/nanoclaw"
    NONCE_FILE="${NONCE_DIR}/.pull-nonce"
    if mkdir -p "$NONCE_DIR" 2>/dev/null; then
        chmod 700 "$NONCE_DIR" 2>/dev/null || true
        NANOCLAW_PULL_NONCE="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
        # umask so the file is never briefly world-readable between create and chmod.
        if (umask 177; printf '%s' "$NANOCLAW_PULL_NONCE" > "$NONCE_FILE") 2>/dev/null; then
            export NANOCLAW_PULL_NONCE
            # Client-asserted, recorded by the broker as a hint only.
            NANOCLAW_PULL_REF="$REF"
            export NANOCLAW_PULL_REF
            trap 'rm -f "$NONCE_FILE"' EXIT
        else
            echo "Warning: couldn't write ${NONCE_FILE}; a gated pull will be refused by the credential helper." >&2
        fi
    else
        echo "Warning: couldn't create ${NONCE_DIR}; a gated pull will be refused by the credential helper." >&2
    fi

    if ! ${CONTAINER_RUNTIME} pull "$REF"; then
        echo "" >&2
        echo "Pull failed for ${REF}." >&2
        echo "  If the registry needs credentials, run \`docker login <registry>\` and" >&2
        echo "  retry — this script deliberately has no credential handling of its own." >&2
        exit 1
    fi
fi

# Architecture. A pinned digest that resolves to a single-arch manifest is the
# common way to end up with an amd64 image on an arm64 host: it runs, slowly,
# under emulation, or not at all. A multi-arch index never trips this — docker
# resolved it to this platform during the pull — so reaching here means the
# reference really did name one architecture, and the wrong one.
IMAGE_ARCH="$(${CONTAINER_RUNTIME} image inspect --format '{{.Architecture}}' "$REF")"
if [ "$IMAGE_ARCH" != "$HOST_ARCH" ]; then
    echo "" >&2
    echo "Architecture mismatch — refusing to tag this image." >&2
    echo "  image   ${IMAGE_ARCH}" >&2
    echo "  daemon  ${HOST_ARCH}" >&2
    echo "" >&2
    echo "If the publisher ships per-architecture references rather than one" >&2
    echo "multi-arch index, use the ${HOST_ARCH} reference." >&2
    exit 1
fi

# Lock drift. /app/node_modules is baked in from container/agent-runner/bun.lock
# while /app/src is bind-mounted from this checkout at every spawn. Pair an image
# with a checkout whose lockfile moved and the agent dies on a missing module
# inside a `--rm` container whose logs are discarded. Hard failure here, where
# the operator is watching, beats silence at 3am.
IMAGE_LOCK="$(${CONTAINER_RUNTIME} image inspect --format '{{index .Config.Labels "dev.nanoclaw.agent-runner-lock-sha256"}}' "$REF")"
if [ "$IMAGE_LOCK" = "<no value>" ]; then
    IMAGE_LOCK=""
fi
LOCAL_LOCK="$(lock_sha256)"

if [ -z "$LOCAL_LOCK" ]; then
    echo "Warning: couldn't hash container/agent-runner/bun.lock — skipping the lock check."
elif [ -z "$IMAGE_LOCK" ]; then
    if [ "$ALLOW_UNLABELED" = "true" ]; then
        echo "Warning: ${REF} carries no agent-runner lock label; accepted via NANOCLAW_ALLOW_UNLABELED_IMAGE."
    else
        echo "" >&2
        echo "${REF} carries no dev.nanoclaw.agent-runner-lock-sha256 label." >&2
        echo "" >&2
        echo "Without it there is no way to tell whether the image's baked" >&2
        echo "/app/node_modules matches this checkout's agent-runner lockfile, and a" >&2
        echo "mismatch surfaces as a missing module inside a --rm container whose logs" >&2
        echo "are discarded." >&2
        echo "" >&2
        echo "Either use an image built from this Dockerfile (which stamps the label)," >&2
        echo "or accept the risk deliberately with NANOCLAW_ALLOW_UNLABELED_IMAGE=true." >&2
        exit 1
    fi
elif [ "$IMAGE_LOCK" != "$LOCAL_LOCK" ]; then
    echo "" >&2
    echo "Agent-runner lock drift — refusing to tag this image." >&2
    echo "  image     ${IMAGE_LOCK}" >&2
    echo "  checkout  ${LOCAL_LOCK}  (container/agent-runner/bun.lock)" >&2
    echo "" >&2
    echo "The image bakes /app/node_modules from the lockfile it was built with," >&2
    echo "while /app/src is mounted from this checkout at spawn time. Running them" >&2
    echo "together fails as a missing module inside a --rm container whose logs are" >&2
    echo "discarded." >&2
    echo "" >&2
    echo "Use the image published for this checkout, or build locally:" >&2
    echo "  ./container/build.sh" >&2
    exit 1
fi

# The retag. From here on the image is indistinguishable, to every consumer,
# from one this machine built itself.
${CONTAINER_RUNTIME} tag "$REF" "$LOCAL_REF"

# An image can carry several RepoDigests -- the same bytes pushed to more than
# one repository all address identically, so docker lists them all. Taking [0]
# reports whichever repository happens to sort first, which is routinely NOT the
# one just pulled. Pick the entry whose repository matches $REF, and only fall
# back to the first when nothing matches.
REF_REPO="${REF%@*}"; REF_REPO="${REF_REPO%%:*}"
DIGEST="$(${CONTAINER_RUNTIME} image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$REF" 2>/dev/null \
    | grep -F "${REF_REPO}@" | head -n1 || true)"
if [ -z "$DIGEST" ]; then
    DIGEST="$(${CONTAINER_RUNTIME} image inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' "$REF" 2>/dev/null || true)"
fi
if [ -n "$DIGEST" ]; then
    echo "Digest: ${DIGEST}"
fi
echo "Tagged ${REF} as ${LOCAL_REF}"
