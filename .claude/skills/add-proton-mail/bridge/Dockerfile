# Proton Mail Bridge, headless, built from source so it runs on arm64 (Raspberry
# Pi) where Proton ships no binary. Two stages: compile with the Go toolchain the
# release's go.mod asks for, then copy the binaries onto a slim runtime.
#
# Everything the build pulls is pinned: base images by digest, and the release
# by its commit (Proton's release tags are lightweight, so there is no tag
# signature to check; the commit itself is signed). Go modules are checked
# against go.sum and the Go checksum database by the toolchain. To upgrade, set
# BRIDGE_VERSION and BRIDGE_COMMIT together:
#   git ls-remote https://github.com/ProtonMail/proton-bridge.git refs/tags/vX.Y.Z
ARG BRIDGE_VERSION=v3.27.0
ARG BRIDGE_COMMIT=04e46eb4fbc1c7ef4425a920bfc352050da0606b
ARG GO_IMAGE=golang:1.26.8-bookworm@sha256:dc9ad6c05acc7a88e5b71bde60a5fe3bd4b9f0db209011711b464107438a8107
ARG RUNTIME_IMAGE=debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8

FROM ${GO_IMAGE} AS build
ARG BRIDGE_VERSION
ARG BRIDGE_COMMIT
RUN apt-get update && apt-get install -y --no-install-recommends git build-essential pkg-config libsecret-1-dev libfido2-dev libcbor-dev libssl-dev libudev-dev libpcsclite-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 --branch "${BRIDGE_VERSION}" https://github.com/ProtonMail/proton-bridge.git . \
    && test "$(git rev-parse HEAD)" = "${BRIDGE_COMMIT}" \
    && make build-nogui vault-editor

FROM ${RUNTIME_IMAGE}
ARG BRIDGE_VERSION
# Read by anything that needs to know which release is running (an update watch).
LABEL org.opencontainers.image.version="${BRIDGE_VERSION}"
# pass + gnupg back the credential store the bridge writes its account into;
# socat re-exposes the bridge's loopback-only listeners on the container
# interface as 2025/2143 so a published port reaches them; jq reads single
# fields out of the vault for setup (bridge-secrets.sh).
RUN apt-get update && apt-get install -y --no-install-recommends \
        pass gnupg socat jq libsecret-1-0 libfido2-1 ca-certificates procps \
    && rm -rf /var/lib/apt/lists/*
# Bridge runs as an unprivileged user. Its home stays /root: the vault records
# absolute paths (Settings.GluonDir), so an existing login keeps working when
# the volume is chowned to this user rather than moved.
RUN groupadd --system --gid 10001 bridge \
    && useradd --system --uid 10001 --gid bridge --home-dir /root --no-create-home --shell /usr/sbin/nologin bridge \
    && chown bridge:bridge /root && chmod 700 /root
COPY --from=build /src/bridge /src/proton-bridge /src/vault-editor /protonmail/
COPY entrypoint.sh bridge-secrets.sh gpgparams /protonmail/
USER bridge
ENV HOME=/root
EXPOSE 2025/tcp 2143/tcp
VOLUME ["/root"]
ENTRYPOINT ["bash", "/protonmail/entrypoint.sh"]
