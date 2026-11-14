#!/usr/bin/env bash
# Run a command suggested by claude-assist, giving the user a chance to
# edit it first. bash 4+ pre-fills readline so Enter literally submits;
# bash 3.x (macOS default /bin/bash) shows the command and waits for Enter.
#
# This script is the allowlisted unit — the `eval` happens inside. The
# caller has already shown the command to the user and gotten confirmation.

set -u

CMD="${1:-}"
if [ -z "$CMD" ]; then
  echo "run-suggested: no command provided" >&2
  exit 1
fi

echo
if [ "${BASH_VERSINFO[0]:-0}" -ge 4 ]; then
  # Pre-fill readline; user can edit before pressing Enter.
  read -r -e -i "$CMD" -p "$ " cmd </dev/tty
else
  # Fallback: display + Enter-to-run.
  echo "$ $CMD"
  read -r -p "Press Enter to run, Ctrl-C to abort. " _ </dev/tty
  cmd="$CMD"
fi

if [ -z "$cmd" ]; then
  echo "run-suggested: empty command after edit, skipping." >&2
  exit 0
fi

echo
eval "$cmd"
