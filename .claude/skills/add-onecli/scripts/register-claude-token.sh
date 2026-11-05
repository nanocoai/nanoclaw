#!/usr/bin/env bash
set -euo pipefail

# Capture a Claude subscription OAuth token for OneCLI — the *only* auth
# path that needs a TTY break in the flow. auth.ts saves every token
# (pasted or captured here) in-process, so a failed save is redacted.
#
# Usage: register-claude-token.sh <output-file>
#
# Flow:
#   1. Run `claude setup-token` under a PTY (via script(1)) so the browser
#      OAuth dance works and its token is captured into a tempfile.
#   2. Parse the sk-ant-oat…AA token out of the capture via the shared
#      PTY-capture parser (setup/lib/captured-token.ts).
#   3. Write it to <output-file>, mode 0600, for auth.ts to save.

# Prefer bash 4+ (for `read -e -i` readline preload). macOS ships 3.2 in
# /bin/bash, but Homebrew users usually have 5.x first on PATH. The
# readline preload is optional — on 3.x we fall back to a plain prompt.

output=${1:?output path required}

if ! command -v claude >/dev/null 2>&1; then
  echo "Claude Code CLI not found — installing it now (needed for subscription sign-in)…"
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if ! bash "$SCRIPT_DIR/install-claude.sh"; then
    echo >&2
    echo "Couldn't install the Claude Code CLI automatically." >&2
    echo "Install it manually with" >&2
    echo "  curl -fsSL https://claude.ai/install.sh | bash" >&2
    echo "and re-run setup." >&2
    exit 1
  fi
  # install-claude.sh PATH additions are scoped to its own subshell; redo
  # them here so the rest of this script can see the fresh `claude` binary.
  if [ -d "$HOME/.local/bin" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
    export PATH="$HOME/.local/bin:$PATH"
  fi
  hash -r 2>/dev/null || true
fi

command -v script >/dev/null \
  || { echo "script(1) is required for PTY capture." >&2; exit 1; }

tmpfile=$(mktemp -t claude-setup-token.XXXXXX)
trap 'rm -f "$tmpfile"' EXIT

# Detect headless. Mirrors `isHeadless()` in setup/platform.ts: on Linux
# with neither DISPLAY nor WAYLAND_DISPLAY set, no graphical session
# exists, so `claude setup-token` won't be able to auto-open a browser
# and the user will need to copy the printed sign-in URL by hand. The
# pre-message copy below is swapped accordingly so we don't promise a
# browser pop that will never happen.
is_headless=0
if [ "$(uname -s)" = "Linux" ] && [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  is_headless=1
fi

if [ "$is_headless" = "1" ]; then
  cat <<'EOF'
A sign-in link will appear for you to sign in with your Claude account.
When you finish, setup saves the token to your OneCLI vault.

Press Enter to continue, or edit the command first.

EOF
else
  cat <<'EOF'
A browser window will open for you to sign in with your Claude account.
When you finish, setup saves the token to your OneCLI vault.

Press Enter to continue, or edit the command first.

EOF
fi

cmd="claude setup-token"
if [ "${BASH_VERSINFO[0]:-0}" -ge 4 ]; then
  # bash 4+: pre-fill the readline buffer so Enter literally submits.
  read -r -e -i "$cmd" -p "$ " cmd </dev/tty
else
  # bash 3.x (macOS default /bin/bash): no readline preload. Fall back.
  echo "$ $cmd"
  read -r -p "Press Enter to run, Ctrl-C to abort. " _ </dev/tty
fi

# `script` arg order differs between BSD (macOS) and util-linux.
if script --version 2>/dev/null | grep -q util-linux; then
  script -q -c "$cmd" "$tmpfile"
else
  # BSD script: command is argv after the file, so let it word-split.
  # shellcheck disable=SC2086
  script -q "$tmpfile" $cmd
fi

# Extract the token via NanoClaw's shared PTY-capture parser,
# so this script and setup/lib/claude-assist.ts stay in lockstep on the
# normalization rules (ANSI/control stripping, un-wrapping the token).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
token=$(pnpm exec tsx setup/lib/captured-token.ts claude "$tmpfile" || true)

if [ -z "$token" ]; then
  keep=$(mktemp -t claude-setup-token-log.XXXXXX)
  cp "$tmpfile" "$keep"
  echo >&2
  echo "No sk-ant-oat…AA token found. Raw log: $keep" >&2
  exit 1
fi

echo
echo "Got token: ${token:0:16}…${token: -4}"
umask 077
printf '%s' "$token" > "$output"
