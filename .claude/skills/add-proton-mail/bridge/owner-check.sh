#!/usr/bin/env bash
# owner-check.sh — refuse to touch a Bridge that another NanoClaw checkout on
# this host set up.
#
# Run from the project root. The Bridge container, volume and network have
# host-global names and fixed loopback ports (one Bridge per host), while
# NanoClaw supports several checkouts side by side. Each resource this skill
# creates carries the label nanoclaw-install=<this checkout's install slug>
# (setup/lib/install-slug.sh, the same label NanoClaw puts on its agent
# containers). If any of them exists with ANOTHER checkout's label, this exits
# 1 and the caller stops, so a second checkout never replaces a running Bridge
# or deletes its login. An unlabelled resource predates the label and is
# treated as this checkout's.
#
# On success prints `nanoclaw-install=<slug>` (the label to apply) on stdout;
# messages go to stderr.
set -euo pipefail
NAME=${PROTON_BRIDGE_NAME:-nanoclaw-proton-bridge}
NETWORK=${PROTON_BRIDGE_NETWORK:-nanoclaw-mail}
PROJECT_ROOT=$PWD
# shellcheck source=/dev/null
source setup/lib/install-slug.sh
mine=$(_nanoclaw_install_slug)

check() { # kind name format
  local owner
  owner=$(docker "$1" inspect -f "$3" "$2" 2>/dev/null) || return 0 # absent
  case "$owner" in
    "" | "<no value>" | "$mine") return 0 ;;
  esac
  echo "owner-check: the $1 '$2' belongs to another NanoClaw checkout on this host (install $owner; this one is $mine)." >&2
  echo "owner-check: one Proton Mail Bridge serves one checkout. Remove Proton Mail from that checkout first (its REMOVE.md), or keep using it there." >&2
  exit 1
}

check container "$NAME" '{{ index .Config.Labels "nanoclaw-install" }}'
check volume "$NAME" '{{ index .Labels "nanoclaw-install" }}'
check network "$NETWORK" '{{ index .Labels "nanoclaw-install" }}'
printf 'nanoclaw-install=%s\n' "$mine"
