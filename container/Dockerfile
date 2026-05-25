# syntax=docker/dockerfile:1.7
# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation.
#
# Runtime split:
#   - agent-runner (our TypeScript code): Bun, mounted RO at /app/src by host
#   - globally-installed Node CLIs (claude-code, agent-browser, vercel): pnpm + Node
#
# Source is never baked in — /app/src is provided by a shared read-only
# bind mount at runtime (see src/container-runner.ts). Source-only changes
# never require an image rebuild.

FROM node:22-trixie-slim

# ---- Build-time arguments ----------------------------------------------------
# CJK fonts add ~200MB. Opt in only if you render Chinese/Japanese/Korean text.
ARG INSTALL_CJK_FONTS=false

# Pin CLI versions for reproducibility. Bump deliberately — unpinned installs
# mean every rebuild silently picks up the latest and can break in lockstep
# across all users.
ARG CLAUDE_CODE_VERSION=2.1.138
ARG AGENT_BROWSER_VERSION=latest
ARG VERCEL_VERSION=53.1.1
ARG BUN_VERSION=1.3.13

# ---- System dependencies -----------------------------------------------------
# tini: correct PID 1 / signal forwarding so outbound.db writes finalize on
# SIGTERM instead of being orphaned by the shell entrypoint.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        fonts-noto-color-emoji \
        libgbm1 \
        libnss3 \
        libatk-bridge2.0-0 \
        libgtk-3-0 \
        libx11-xcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxrandr2 \
        libasound2 \
        libpangocairo-1.0-0 \
        libcups2 \
        libdrm2 \
        libxshmfence1 \
        ca-certificates \
        curl \
        git \
        tini \
        unzip \
    && if [ "$INSTALL_CJK_FONTS" = "true" ]; then \
        apt-get install -y --no-install-recommends fonts-noto-cjk; \
       fi \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/share/icons/Adwaita /usr/share/doc/*

# Chromium path for agent-browser / Playwright consumers
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
# Belt-and-braces: prevent Playwright's postinstall from downloading its own
# ~300MB Chromium. We've already installed the system one above.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# ---- Bun runtime -------------------------------------------------------------
# Install via the official script (handles multi-arch detection), then move
# the binary to /usr/local/bin so the non-root `node` user can execute it.
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" && \
    install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun && \
    rm -rf /root/.bun

# ---- agent-runner deps -------------------------------------------------------
# Deps are cached independently of CLI versions. Source is NOT baked in —
# it's provided by the shared RO mount at runtime.
WORKDIR /app

COPY agent-runner/package.json agent-runner/bun.lock ./

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production \
    && rm -rf /app/node_modules/@anthropic-ai/claude-agent-sdk-*-musl

# ---- pnpm + global Node CLIs -------------------------------------------------
# Most stable first, most frequently bumped last. Bumping claude-code
# (the most common change) only invalidates one layer.
#
# only-built-dependencies gates pnpm's supply-chain policy:
#   - agent-browser has a postinstall build step.
#   - @anthropic-ai/claude-code's postinstall downloads the native Claude
#     binary (linux-arm64 variant on our image). Without the allowlist
#     the SDK fails at spawn time with "native binary not found".
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Pin pnpm to match the host (package.json packageManager). pnpm 11 stopped
# honoring `only-built-dependencies[]=` in .npmrc for global installs, which
# silently skips claude-code's native-binary postinstall and agent-browser's
# bin chmod — the agent then crashes at runtime with "native binary not
# installed". Keep this in lockstep with package.json's `packageManager`.
ARG PNPM_VERSION=10.33.0
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

RUN --mount=type=cache,target=/root/.cache/pnpm \
    echo "only-built-dependencies[]=agent-browser" > /root/.npmrc && \
    echo "only-built-dependencies[]=@anthropic-ai/claude-code" >> /root/.npmrc && \
    pnpm install -g "vercel@${VERCEL_VERSION}" \
    && rm -rf /pnpm/store

# agent-browser ships all 7 OS+arch binaries (~62MB) inside the package; keep
# only the one matching the build host. Mapping: dpkg amd64 → linux-x64,
# dpkg arm64 → linux-arm64. ~50MB saved.
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "agent-browser@${AGENT_BROWSER_VERSION}" \
    && rm -rf /pnpm/store \
    && case "$(dpkg --print-architecture)" in \
         arm64) AB_BIN=agent-browser-linux-arm64 ;; \
         amd64) AB_BIN=agent-browser-linux-x64 ;; \
         *) echo "unknown arch: $(dpkg --print-architecture)" >&2; exit 1 ;; \
       esac \
    && find /pnpm/global/5/.pnpm/agent-browser@*/node_modules/agent-browser/bin \
         -mindepth 1 -type f \
         ! -name "$AB_BIN" ! -name 'agent-browser.js' ! -name '.install-method' \
         -delete

# claude-code is installed LAST so its cleanup persists. Each `pnpm install -g`
# resyncs the shared global lockfile and would re-fetch any package directory
# missing from disk; doing the dup-cleanup in any earlier RUN gets reverted.
#
# claude-code's postinstall copies the native binary from the variant package
# (e.g. @anthropic-ai/claude-code-linux-arm64) into bin/claude.exe in the
# wrapper. After that copy, the variant package directory is a ~238MB dead
# duplicate. Remove it and the now-dangling symlink in the wrapper.
#
# The wrapper's bin/claude.exe (~249MB) is also byte-identical to the SDK's
# native binary at /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-*/claude
# whenever the SDK and CLI carry the same upstream claude-code version.
# Replace it with a symlink to save another ~249MB. Done in the same RUN as
# the install so the postinstall-copied binary never persists into the layer.
# A SHA256 mismatch fails the build — that means @anthropic-ai/claude-agent-sdk
# in container/agent-runner/package.json has drifted from CLAUDE_CODE_VERSION
# and must be re-aligned.
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && rm -rf /pnpm/store \
    && rm -rf /pnpm/global/5/.pnpm/@anthropic-ai+claude-code-linux-*@* \
    && rm -f /pnpm/global/5/.pnpm/@anthropic-ai+claude-code@*/node_modules/@anthropic-ai/claude-code-linux-* \
    && case "$(dpkg --print-architecture)" in \
         arm64) SDK_ARCH=linux-arm64 ;; \
         amd64) SDK_ARCH=linux-x64 ;; \
         *) echo "unknown arch: $(dpkg --print-architecture)" >&2; exit 1 ;; \
       esac \
    && SDK_BIN="/app/node_modules/@anthropic-ai/claude-agent-sdk-${SDK_ARCH}/claude" \
    && CLI_BIN=$(ls /pnpm/global/5/.pnpm/@anthropic-ai+claude-code@*/node_modules/@anthropic-ai/claude-code/bin/claude.exe) \
    && [ "$(sha256sum "$SDK_BIN" | cut -d' ' -f1)" = "$(sha256sum "$CLI_BIN" | cut -d' ' -f1)" ] \
       || { echo "ERROR: claude-agent-sdk native binary != claude-code wrapper binary." >&2; \
            echo "  SDK : $SDK_BIN" >&2; echo "  CLI : $CLI_BIN" >&2; \
            echo "  Bump @anthropic-ai/claude-agent-sdk in container/agent-runner/package.json" >&2; \
            echo "  to match CLAUDE_CODE_VERSION=${CLAUDE_CODE_VERSION} (so both ship the same native bin)." >&2; \
            exit 1; } \
    && ln -sf "$SDK_BIN" "$CLI_BIN"

# ---- ncl CLI wrapper ----------------------------------------------------------
# Actual script lives in the mounted source at /app/src/cli/ncl.ts.
RUN printf '#!/bin/sh\nexec bun /app/src/cli/ncl.ts "$@"\n' > /usr/local/bin/ncl && \
    chmod +x /usr/local/bin/ncl

# ---- Entrypoint --------------------------------------------------------------
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# ---- Workspace + permissions -------------------------------------------------
RUN mkdir -p /workspace/group /workspace/extra && \
    chown -R node:node /workspace && \
    chmod 777 /home/node

USER node
WORKDIR /workspace/group

# tini is PID 1, reaps zombies, forwards signals cleanly. entrypoint.sh does
# `exec bun ...` so bun runs as tini's direct child.
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
