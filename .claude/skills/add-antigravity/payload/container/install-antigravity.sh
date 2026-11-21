#!/bin/sh
# Install the pinned Google Antigravity CLI (`agy`) into the agent image.
#
# Antigravity ships as a native Go binary, not an npm package, so it cannot go
# through container/cli-tools.json. Google's own installer (`curl … | bash`)
# always fetches the newest release, so this script downloads one exact build
# instead and refuses anything whose sha512 does not match the pin below.
#
# Called from the block /add-antigravity appends to container/Dockerfile, as
# root, with the version the Dockerfile pins and no argument:
#
#   AGY_REQUESTED_VERSION="${AGY_VERSION}" sh /tmp/install-antigravity.sh
#
# A requested version other than the one pinned below is refused before any
# download: the Dockerfile ARG is the pin the repo's pin inventory sees, and the
# hashes here belong to exactly one version. The script installs the build for
# `uname -m`, which inside a RUN step reports the target platform, natively or
# under emulation. An explicit amd64 | arm64 argument overrides that; the
# installer's own test passes one.
#
# AGY_INSTALL_DIR overrides the destination directory (default /usr/local/bin);
# the installer's own test uses it to install into a temporary prefix.
#
# To bump: take the new version and execution id from the official changelog,
# download both tarballs, recompute both sha512 sums, and change all four
# values together, plus `ARG AGY_VERSION` in the Dockerfile block.
# src/antigravity-dockerfile.test.ts goes red if any of them disappears or the
# two versions differ.
set -eu

AGY_VERSION=1.5.8
AGY_EXECUTION_ID=4602374149505024
AGY_SHA512_AMD64=f08faaee588327dba8722bdc60f26a14f6915a8f2d756ed7959cde0a706d4e62fd9f831ab1a077dace5f947caaa6e851457df5023180bb8d3f54386804a3787f
AGY_SHA512_ARM64=7b040bfb8fb96f7550a8a66cd0ac28cb3e6e40e427f1e9810bfe1bf23c417cb9b363e36b2fc8ed645fe1ee518b0106f50f03de7084e95ede4591a893527360d1
AGY_BASE_URL="https://storage.googleapis.com/antigravity-public/antigravity-cli/${AGY_VERSION}-${AGY_EXECUTION_ID}"
AGY_INSTALL_DIR="${AGY_INSTALL_DIR:-/usr/local/bin}"

requested="${AGY_REQUESTED_VERSION:-}"
if [ -n "$requested" ] && [ "$requested" != "$AGY_VERSION" ]; then
  echo "install-antigravity: the Dockerfile asks for agy ${requested}, but this script pins ${AGY_VERSION}; change the version, execution id and both sha512 sums here together" >&2
  exit 1
fi

arch="${1:-}"
if [ -z "$arch" ]; then
  # No argument (the Dockerfile block): use the platform the build runs as.
  case "$(uname -m)" in
    x86_64 | amd64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) arch="$(uname -m)" ;;
  esac
fi

case "$arch" in
  amd64)
    url="${AGY_BASE_URL}/linux-x64/cli_linux_x64.tar.gz"
    sha512="$AGY_SHA512_AMD64"
    ;;
  arm64)
    url="${AGY_BASE_URL}/linux-arm/cli_linux_arm64.tar.gz"
    sha512="$AGY_SHA512_ARM64"
    ;;
  *)
    echo "install-antigravity: unsupported architecture '${arch}' (Antigravity CLI ${AGY_VERSION} ships linux amd64 and arm64 only)" >&2
    exit 1
    ;;
esac

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT INT TERM

echo "install-antigravity: downloading Antigravity CLI ${AGY_VERSION} (${arch})"
curl -fsSL --retry 3 --retry-delay 5 -o "$work/cli.tar.gz" "$url"

# Two spaces between hash and name: the format sha512sum -c reads.
printf '%s  %s\n' "$sha512" "$work/cli.tar.gz" > "$work/cli.tar.gz.sha512"
sha512sum -c "$work/cli.tar.gz.sha512"

# The tarball holds a single file, `antigravity`; NanoClaw runs it as `agy`.
tar -xzf "$work/cli.tar.gz" -C "$work" antigravity
install -m 0755 "$work/antigravity" "$AGY_INSTALL_DIR/agy"

# Smoke check: the binary runs on this image and is the pinned build. Auto-update
# stays off here too (only the literal `true` disables it).
installed="$(AGY_CLI_DISABLE_AUTO_UPDATE=true "$AGY_INSTALL_DIR/agy" --version)"
if [ "$installed" != "$AGY_VERSION" ]; then
  echo "install-antigravity: expected agy ${AGY_VERSION}, got '${installed}'" >&2
  exit 1
fi
echo "install-antigravity: agy ${installed} installed at ${AGY_INSTALL_DIR}/agy"
