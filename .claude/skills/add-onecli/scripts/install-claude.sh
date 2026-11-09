#!/usr/bin/env bash
# Install the Claude Code CLI on the host via the official native installer.
# Invoked from setup/register-claude-token.sh when the user picks the
# subscription auth path and `claude` is missing. The other two auth paths
# (paste OAuth token, paste API key) don't need the CLI, so this runs on
# demand rather than up front.
#
# The native installer is Node-independent (downloads a prebuilt binary to
# ~/.local/bin) and is the path Anthropic documents. This matches the
# pattern used by install-docker.sh / install-node.sh: the script itself is
# the allowlisted unit; the curl | bash pipe lives inside it.

set -euo pipefail

echo "=== NANOCLAW SETUP: INSTALL_CLAUDE ==="

if command -v claude >/dev/null 2>&1; then
  echo "STATUS: already-installed"
  echo "CLAUDE_VERSION: $(claude --version 2>/dev/null || echo unknown)"
  echo "=== END ==="
  exit 0
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "STATUS: failed"
  echo "ERROR: curl not available."
  echo "=== END ==="
  exit 1
fi

echo "STEP: claude-native-install"
curl -fsSL https://claude.ai/install.sh | bash

# Native installer writes to ~/.local/bin and appends a PATH line to the
# user's rc file; that doesn't help this session, so put it on PATH now.
if [ -d "$HOME/.local/bin" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  export PATH="$HOME/.local/bin:$PATH"
fi
hash -r 2>/dev/null || true

if ! command -v claude >/dev/null 2>&1; then
  echo "STATUS: failed"
  echo "ERROR: claude not found on PATH after install."
  echo "=== END ==="
  exit 1
fi

echo "STATUS: installed"
echo "CLAUDE_VERSION: $(claude --version 2>/dev/null || echo unknown)"
echo "=== END ==="
