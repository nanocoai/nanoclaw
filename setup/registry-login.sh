#!/usr/bin/env bash
set -euo pipefail

# Interactive sign-in for the gated agent-image path.
#
# This is a `runInheritScript` target, never a step-runner step. The step
# runner spawns with stdin discarded and gives up on a child that goes quiet
# for 60 seconds; a device-code wait is minutes of deliberate silence at a
# prompt the user has to answer. Same reasoning as the Claude subscription
# sign-in next door, and the only reason a shell wrapper exists at all: one
# stable path to spawn with `stdio: 'inherit'`, and a preflight that fails
# with something an operator can act on instead of "command not found".
#
# `exec` hands the terminal straight to the driver so a Ctrl-C during the wait
# reaches the process that owns the prompt rather than this shell.
#
# Env (all optional, all read by the driver itself):
#   NANOCLAW_REGISTRY_TOKEN        Existing account token — adopt it, no prompts
#   NANOCLAW_REGISTRY_ENROLL_CODE  Operator-issued code — enroll, no prompts
#   NANOCLAW_REGISTRY_API          Broker base URL
#   NANOCLAW_WORKOS_CLIENT_ID      Device-flow client id (public, not a secret)
#
# Exit codes:
#   0  signed in, or already signed in
#   2  deliberately skipped — the caller may continue on the unauthenticated
#      path (no credentials supplied under --non-interactive, or user declined)
#   1  failed

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# A node or pnpm installed into ~/.local/bin earlier in this same setup run is
# invisible to a freshly spawned shell; setup/auto.ts repairs PATH the same way
# before its own interactive scripts.
if [ -d "$HOME/.local/bin" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  export PATH="$HOME/.local/bin:$PATH"
fi
hash -r 2>/dev/null || true

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm not found — sign-in needs it to run the setup driver." >&2
  echo "Run setup's environment step first, or install pnpm and re-run." >&2
  exit 1
fi

cd "$PROJECT_ROOT"
exec pnpm exec tsx setup/registry-login.ts "$@"
