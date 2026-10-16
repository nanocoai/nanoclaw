#!/bin/bash
# Tirith security scan wrapper.
# Usage: scan.sh <text> [exec|paste]
#   exec  = scan a command before execution (tirith check)
#   paste = scan untrusted text/URLs (tirith paste, default)
#
# Exit codes 0/1/2 from tirith are valid verdicts — JSON is returned as-is.
# Only fail-open on actual spawn/install errors.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
bash "$SCRIPT_DIR/install.sh" 2>/dev/null || true

TIRITH="/home/node/.claude/bin/tirith"
if [ ! -x "$TIRITH" ]; then
    echo '{"action":"allow","findings":[],"error":"tirith not installed"}'
    exit 0
fi

TEXT="${1:-}"
CONTEXT="${2:-paste}"

# Run tirith — exit 0=allow, 1=block, 2=warn are all valid verdicts.
# Only fail-open on actual spawn/install errors (exit 126/127/signal).
if [ "$CONTEXT" = "exec" ]; then
    OUTPUT=$("$TIRITH" check --json --non-interactive --shell posix -- "$TEXT" 2>/dev/null) && true
    EXIT_CODE=$?
else
    OUTPUT=$(printf '%s\n' "$TEXT" | "$TIRITH" paste --json --non-interactive 2>/dev/null) && true
    EXIT_CODE=$?
fi

# Exit codes 0, 1, 2 are valid tirith verdicts — return the JSON as-is
if [ "$EXIT_CODE" -le 2 ] && [ -n "$OUTPUT" ]; then
    echo "$OUTPUT"
else
    # Spawn error, timeout, or empty output — fail-open
    echo '{"action":"allow","findings":[],"error":"tirith execution failed"}'
fi
