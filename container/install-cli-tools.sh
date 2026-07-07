#!/bin/sh
# Install the global Node CLIs the agent invokes at runtime, from cli-tools.json.
#
# A skill adds a tool by appending a { "name", "version" } entry to that
# manifest (a json-merge) instead of editing the Dockerfile — the reach-in
# becomes the safest change shape, deterministic and removable.
#
# Every tool is installed via `pnpm install -g`, pinned to an exact version, so
# the pnpm supply-chain policy still applies. Tools with a native postinstall
# set "onlyBuilt": true to opt in to running build scripts (pnpm skips them by
# default). Run as root before `USER node`, so /root/.npmrc is the right home.
set -eu

MANIFEST="${1:-/tmp/cli-tools.json}"

# Write the per-tool only-built-dependencies opt-ins pnpm reads at install time.
node -e '
  const tools = require(process.argv[1]);
  const optIns = tools.filter((t) => t.onlyBuilt).map((t) => "only-built-dependencies[]=" + t.name);
  require("fs").writeFileSync("/root/.npmrc", optIns.join("\n") + (optIns.length ? "\n" : ""));
' "$MANIFEST"

# Install every tool, pinned. name@version specs never contain spaces, so the
# unquoted expansion word-splits cleanly into positional args.
# shellcheck disable=SC2046
set -- $(node -e 'require(process.argv[1]).forEach((t) => console.log(t.name + "@" + t.version))' "$MANIFEST")
if [ "$#" -gt 0 ]; then
  pnpm install -g "$@"
fi
