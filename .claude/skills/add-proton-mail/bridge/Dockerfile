# Proton Mail Bridge, headless, built from source so it runs on arm64 (Raspberry
# Pi) where Proton ships no binary. Two stages: compile with the Go toolchain the
# release's go.mod asks for, then copy the binaries onto a slim runtime.
ARG BRIDGE_VERSION=v3.26.0
ARG GO_IMAGE=golang:1.26.8-bookworm

FROM ${GO_IMAGE} AS build
ARG BRIDGE_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends git build-essential pkg-config libsecret-1-dev libfido2-dev libcbor-dev libssl-dev libudev-dev libpcsclite-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 --branch "${BRIDGE_VERSION}" https://github.com/ProtonMail/proton-bridge.git . \
    && make build-nogui vault-editor

FROM debian:bookworm-slim
# pass + gnupg back the credential store the bridge writes its account into;
# socat re-exposes the bridge's loopback-only listeners on the container
# interface as 2025/2143 so a published port reaches them.
RUN apt-get update && apt-get install -y --no-install-recommends \
        pass gnupg socat libsecret-1-0 libfido2-1 ca-certificates procps \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/bridge /src/proton-bridge /src/vault-editor /protonmail/
COPY entrypoint.sh gpgparams /protonmail/
EXPOSE 2025/tcp 2143/tcp
VOLUME ["/root"]
ENTRYPOINT ["bash", "/protonmail/entrypoint.sh"]
