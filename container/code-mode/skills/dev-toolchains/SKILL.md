---
name: dev-toolchains
description: Install the toolchain versions a project declares under the persistent /workspace/tools, keep package caches there, and honor the environment's proxy and trust.
---

# Project toolchains

## What the image provides

A Debian-based Node image running as the unprivileged user `node`: Node, Bun,
pnpm, npm, git, curl and unzip (`node --version` tells the exact release). No
root, no `sudo`, no `apt`, no Docker daemon. Everything else is installed
under `/workspace/tools`, which survives a container restart; the home
directory does not.

## Layout and PATH

```bash
mkdir -p /workspace/tools/bin
export PATH="/workspace/tools/bin:$PATH"
```

Install each tool under `/workspace/tools/<tool>/<version>/` and link its
executables into `/workspace/tools/bin`. Check what is already there before
installing, and use the versions the project declares (`.nvmrc`,
`.tool-versions`, `package.json` engines, `go.mod`, `rust-toolchain.toml`).
Keep your exports in `/workspace/tools/env.sh` and source it in each shell;
the environment does not persist between sessions.

## Install recipe

1. Download the publisher's release archive for Linux and the container's
   architecture (`uname -m`).
2. Verify it against the publisher's checksum or signature; stop and report a
   mismatch rather than installing.
3. Unpack under `/workspace/tools/<tool>/<version>/`, then link:

```bash
ln -sf /workspace/tools/<tool>/<version>/bin/<tool> /workspace/tools/bin/<tool>
```

## Caches and homes in the workspace

Point package managers at the workspace so downloads survive a restart and
never land in the disposable home directory:

```bash
export npm_config_cache=/workspace/tools/cache/npm
export PNPM_HOME=/workspace/tools/pnpm PNPM_STORE_DIR=/workspace/tools/cache/pnpm
export GOPATH=/workspace/tools/go GOMODCACHE=/workspace/tools/cache/go
export CARGO_HOME=/workspace/tools/cargo RUSTUP_HOME=/workspace/tools/rustup
export PIP_CACHE_DIR=/workspace/tools/cache/pip
```

## Proxy and trust

Honor the supplied proxy and trust configuration, including `HTTPS_PROXY`,
`NO_PROXY`, `SSL_CERT_FILE` and `NODE_EXTRA_CA_CERTS`. Report inaccessible
download origins to the operator on the chat surface.
