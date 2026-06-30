# nanoclaw-render — standalone document-rendering image (Quarto + LaTeX + Chromium).
#
# Host-mediated, ephemeral. The host runs `docker run --rm --network none` of
# this image over a session's workspace to render .qmd/.md → PDF/HTML/DOCX; the
# artifact lands back in the mounted workspace. Deliberately kept OUT of the
# agent image so the agent stays lean and this heavy, attack-prone toolchain
# (LaTeX shell-escape via \write18, chromium) is isolated, run with no network,
# and never sees agent secrets.
FROM debian:bookworm-slim

ARG QUARTO_VERSION=1.9.38

# Base tools + chromium (mermaid/diagrams, HTML→PDF) + base fonts.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        chromium \
        fonts-liberation \
        fonts-dejavu-core \
        lmodern \
    && rm -rf /var/lib/apt/lists/*

# Quarto: the .deb bundles pandoc, dart-sass and esbuild (HTML + Word work
# standalone). Asset arch (arm64/amd64) matches `dpkg --print-architecture`.
RUN ARCH="$(dpkg --print-architecture)" && \
    curl -fsSL "https://github.com/quarto-dev/quarto-cli/releases/download/v${QUARTO_VERSION}/quarto-${QUARTO_VERSION}-linux-${ARCH}.deb" -o /tmp/quarto.deb && \
    apt-get update && apt-get install -y --no-install-recommends /tmp/quarto.deb && \
    rm -f /tmp/quarto.deb && rm -rf /var/lib/apt/lists/*

# Curated TeX Live subset for PDF (Quarto's default engine is lualatex). Build
# the luaotfload font DB now, as root, into the system cache so `quarto render
# --to pdf` works offline under any runtime UID (no per-user cache write).
RUN apt-get update && apt-get install -y --no-install-recommends \
        texlive-luatex \
        texlive-xetex \
        texlive-latex-recommended \
        texlive-latex-extra \
        texlive-fonts-recommended \
    && rm -rf /var/lib/apt/lists/* \
    && luaotfload-tool --update --force

# Run renders unprivileged. HOME/XDG under /tmp so quarto/deno/chromium caches
# are writable regardless of the (arbitrary) runtime UID; only /work is mounted.
ENV HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    CHROMIUM_PATH=/usr/bin/chromium \
    QUARTO_CHROMIUM=/usr/bin/chromium

WORKDIR /work
# Default to the quarto CLI; the host passes `render <src> --to <fmt> ...`.
# Override with `--entrypoint` for direct chromium/pandoc invocations.
ENTRYPOINT ["quarto"]
CMD ["--version"]
