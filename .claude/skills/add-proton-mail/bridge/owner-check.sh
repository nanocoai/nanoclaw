#!/usr/bin/env bash
# owner-check.sh — refuse to touch a Bridge that another NanoClaw checkout on
# this host set up.
#
# Run from the project root. The Bridge image, container, volume and network
# have host-global names and fixed loopback ports (one Bridge per host), while
# NanoClaw supports several checkouts side by side. Each resource this skill
# creates carries the label nanoclaw-proton-owner=<this checkout's install
# slug>. If one of them exists with ANOTHER checkout's label, this exits 3 and
# the caller stops, so a second checkout (another clone, or a git worktree of
# this one) never replaces a running Bridge or deletes its login.
#
# Not NanoClaw's own `nanoclaw-install` label: the host's startup reconciliation
# force-removes every container carrying that label without a session label.
#
# The slug matches src/install-slug.ts: NANOCLAW_INSTALL_ID if set, otherwise
# sha1 of the physical project path (process.cwd() resolves symlinks).
#
# An unlabelled resource comes from a version of this skill before the label.
# It counts as this checkout's only if this checkout's .env already holds the
# bridge password, i.e. this checkout set Bridge up. Docker errors other than
# "no such object" (daemon down, socket denied) stop the caller too.
#
# PROTON_BRIDGE_ADOPT=1 takes over a Bridge whose owner no longer exists (the
# checkout was moved or deleted). Then re-run Run Bridge to relabel it.
#
# On success prints `nanoclaw-proton-owner=<slug>` (the label to apply) on
# stdout; messages go to stderr.
set -euo pipefail
NAME=${PROTON_BRIDGE_NAME:-nanoclaw-proton-bridge}
NETWORK=${PROTON_BRIDGE_NETWORK:-nanoclaw-mail}
KEY=nanoclaw-proton-owner

if [[ -n "${NANOCLAW_INSTALL_ID:-}" ]]; then
  if ! [[ "$NANOCLAW_INSTALL_ID" =~ ^[a-z0-9][a-z0-9_-]{0,31}$ ]]; then
    echo "owner-check: NANOCLAW_INSTALL_ID must be 1-32 chars of [a-z0-9_-] starting alphanumeric" >&2
    exit 1
  fi
  mine=$NANOCLAW_INSTALL_ID
else
  PROJECT_ROOT=$(pwd -P)
  unset NANOCLAW_PROJECT_ROOT
  # shellcheck source=/dev/null
  source setup/lib/install-slug.sh
  mine=$(_nanoclaw_install_slug)
fi

# With no docker at all, no Bridge image, container, volume or network can
# exist here, so there is nothing of another checkout's to protect (REMOVE.md
# on a host where Docker was already uninstalled can then finish).
if ! command -v docker >/dev/null 2>&1; then
  echo "owner-check: docker is not installed — no Bridge resources can exist on this host" >&2
  printf '%s=%s\n' "$KEY" "$mine"
  exit 0
fi

configured_here() {
  grep -Eq '^PROTON_MAIL_BRIDGE_PASSWORD=.+' .env 2>/dev/null
}

refuse() {
  echo "owner-check: $1" >&2
  if [[ "${PROTON_BRIDGE_ADOPT:-}" == 1 ]]; then
    echo "owner-check: PROTON_BRIDGE_ADOPT=1 — taking it over for this checkout ($mine)." >&2
    return 0
  fi
  echo "owner-check: one Proton Mail Bridge serves one checkout. Remove Proton Mail from that checkout first (its REMOVE.md), or keep using it there. If that checkout no longer exists (moved or deleted), re-run with PROTON_BRIDGE_ADOPT=1." >&2
  exit 3
}

check() { # kind name format
  local out owner
  if ! out=$(docker "$1" inspect -f "$3" "$2" 2>&1); then
    if grep -Eqi 'no such (container|volume|image|object)|not found' <<<"$out"; then
      return 0 # absent
    fi
    echo "owner-check: cannot ask docker about the $1 '$2': $out" >&2
    exit 1
  fi
  owner=$out
  case "$owner" in
    "$mine") return 0 ;;
    "" | "<no value>")
      configured_here && return 0
      refuse "the $1 '$2' predates ownership labels and this checkout's .env has no Proton Mail Bridge setup, so it belongs to another checkout."
      ;;
    *) refuse "the $1 '$2' belongs to another NanoClaw checkout on this host (install $owner; this one is $mine)." ;;
  esac
}

check image "$NAME:latest" "{{ index .Config.Labels \"$KEY\" }}"
check container "$NAME" "{{ index .Config.Labels \"$KEY\" }}"
check volume "$NAME" "{{ index .Labels \"$KEY\" }}"
check network "$NETWORK" "{{ index .Labels \"$KEY\" }}"
printf '%s=%s\n' "$KEY" "$mine"
