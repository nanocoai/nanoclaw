#!/bin/sh
# Install the CLIs the agent invokes at runtime, from cli-tools.json.
#
# A skill adds a tool by appending an entry to that manifest (a json-merge)
# instead of editing the Dockerfile — the reach-in becomes the safest change
# shape, deterministic and removable.
#
# Two kinds of entry, both pinned:
#
#   npm      { "name", "version" }  — installed with `pnpm install -g`, so the
#            pnpm supply-chain policy still applies. Tools with a native
#            postinstall set "onlyBuilt": true to opt in to running build
#            scripts (pnpm skips them by default).
#
#   binary   { "name", "version", "binary": { "<arch>": { "url", "sha256" } } }
#            — a prebuilt release archive for a CLI that is not published on
#            npm. Fetched for the image's architecture, checksum-verified, and
#            installed 0755 into /usr/local/bin (already on the container PATH).
#            The sha256 is what pinning an exact npm version is for the entries
#            above: the URL alone proves nothing, so a moving URL (a `latest`
#            redirect, a branch tarball, an installer script) does not belong
#            in this manifest.
#
# Run as root before `USER node`, so /root/.npmrc and /usr/local/bin are both
# writable. container/build.sh re-runs this whole manifest as one overlay layer
# on installs that pull a published image, so both kinds land there too.
set -eu

MANIFEST="${1:-/tmp/cli-tools.json}"

# Destinations, overridable so this script can be exercised outside a docker
# build (container/cli-tools.test.ts drives it against a fixture manifest).
# The defaults are the real ones the image build relies on.
BIN_DIR="${CLI_TOOLS_BIN_DIR:-/usr/local/bin}"
NPMRC="${CLI_TOOLS_NPMRC:-/root/.npmrc}"

# ---- npm entries -------------------------------------------------------------

# Write the per-tool only-built-dependencies opt-ins pnpm reads at install time.
node -e '
  const tools = require(process.argv[1]);
  const optIns = tools.filter((t) => !t.binary && t.onlyBuilt).map((t) => "only-built-dependencies[]=" + t.name);
  require("fs").writeFileSync(process.argv[2], optIns.join("\n") + (optIns.length ? "\n" : ""));
' "$MANIFEST" "$NPMRC"

# Install every npm tool, pinned. name@version specs never contain spaces, so
# the unquoted expansion word-splits cleanly into positional args.
# shellcheck disable=SC2046
set -- $(node -e 'require(process.argv[1]).filter((t) => !t.binary).forEach((t) => console.log(t.name + "@" + t.version))' "$MANIFEST")
if [ "$#" -gt 0 ]; then
  pnpm install -g "$@"
fi

# ---- binary entries ----------------------------------------------------------

# Debian's own name for the arch, which is what release archives are keyed on
# here. `uname -m` is the fallback for a base image without dpkg.
arch="$(dpkg --print-architecture 2>/dev/null || true)"
if [ -z "$arch" ]; then
  case "$(uname -m)" in
    x86_64 | amd64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) arch="$(uname -m)" ;;
  esac
fi

# One tab-separated `name url sha256` line per binary entry, for THIS arch. An
# entry with no target for the arch being built is a hard error: silently
# skipping it would produce an image whose agent is missing a tool a skill
# already told it to use.
targets="$(mktemp)"
node -e '
  const tools = require(process.argv[1]);
  const arch = process.argv[2];
  const lines = [];
  for (const tool of tools) {
    if (!tool.binary) continue;
    const target = tool.binary[arch];
    if (!target || !target.url || !target.sha256) {
      throw new Error(`cli-tools.json: ${tool.name}@${tool.version} has no "${arch}" binary target`);
    }
    lines.push([tool.name, target.url, target.sha256].join("\t"));
  }
  require("fs").writeFileSync(process.argv[3], lines.map((l) => l + "\n").join(""));
' "$MANIFEST" "$arch" "$targets"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    echo "no sha256 tool available (sha256sum or shasum)" >&2
    return 1
  fi
}

mkdir -p "$BIN_DIR"

# Redirected rather than piped: a `while read` on the right of a pipe runs in a
# subshell, where `set -e` aborts only that subshell.
while IFS="$(printf '\t')" read -r name url sha; do
  [ -n "$name" ] || continue
  echo "Installing $name from $url"
  work="$(mktemp -d)"
  archive="$work/archive.tar.gz"
  curl -fsSL "$url" -o "$archive"
  actual="$(sha256_of "$archive")"
  if [ "$actual" != "$sha" ]; then
    echo "checksum mismatch for $name" >&2
    echo "  expected: $sha" >&2
    echo "  actual:   $actual" >&2
    rm -rf "$work"
    exit 1
  fi
  tar -xzf "$archive" -C "$work"
  # The archive may nest the binary under a versioned directory; the file named
  # after the tool is the one that goes on PATH.
  found="$(find "$work" -type f -name "$name" | head -n1)"
  if [ -z "$found" ]; then
    echo "archive for $name contains no file named \"$name\"" >&2
    rm -rf "$work"
    exit 1
  fi
  install -m 0755 "$found" "$BIN_DIR/$name"
  rm -rf "$work"
done < "$targets"

rm -f "$targets"
