#!/bin/bash
# The agent image published for the newest release in this checkout's history
# that has one, printed as "<release> <ref>". Prints nothing when there is none:
# no official remote, or no listed release in this checkout's history.
#
# The hardened image is built from a release after it ships, so it can never be
# in that release's own versions.json. agent-images.json on the official
# remote's main maps release -> image instead, one reviewed PR per image.
#
# container/pull.sh and setup/lib/registry-state.ts both call this, so --status
# reports what a pull would use. --fetch refreshes <remote>/main first, best
# effort: offline, the last fetched list still answers.
#
# Usage: container/release-image.sh [--fetch]

set -u

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
git_() { git -C "$PROJECT_ROOT" "$@"; }

# The same rule /update-nanoclaw uses to pick the official remote.
if git_ remote get-url upstream >/dev/null 2>&1; then
    REMOTE=upstream
elif git_ remote get-url origin 2>/dev/null | grep -Eq '(^|[:/])nanocoai/nanoclaw(\.git)?$'; then
    REMOTE=origin
else
    exit 0
fi

if [ "${1:-}" = "--fetch" ]; then
    # Never prompt: pull.sh runs with stdin discarded.
    GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh} -o BatchMode=yes" \
        git_ fetch --quiet --no-tags "$REMOTE" "+refs/heads/main:refs/remotes/$REMOTE/main" >/dev/null 2>&1 || true
fi

LIST="$(git_ show "$REMOTE/main:agent-images.json" 2>/dev/null)" || exit 0

# Newest first. A release whose image is not built yet falls back to the one
# before it, never past it to the versions.json pin. Release candidates never
# get an image.
for RELEASE in $(git_ tag --merged HEAD --list 'v[0-9]*' --sort=-v:refname 2>/dev/null); do
    case "$RELEASE" in *-*) continue ;; esac
    # Flat, one level, string values: grep is enough, as in pull.sh.
    REF="$(printf '%s\n' "$LIST" \
        | grep -o "\"${RELEASE//./\\.}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
        | head -n1 | sed 's/.*:[[:space:]]*"//; s/"$//')"
    if [ -n "$REF" ]; then
        printf '%s %s\n' "$RELEASE" "$REF"
        exit 0
    fi
done
