#!/usr/bin/env bash
#
# Release checkout: decide whether a new install should move from the tip of
# main to the latest release before setup runs.
#
# A plain `git clone` lands on main, which is usually past the newest release,
# while updates follow releases by default. Left alone, the first update stops
# and asks which one the install follows. Sourced by nanoclaw.sh; needs only
# git, since it runs before Node is installed.

# release_checkout_saved_channel <root> — NANOCLAW_UPDATE_CHANNEL from .env, if any.
release_checkout_saved_channel() {
  [ -f "$1/.env" ] || return 0
  # `|| true`: no assignment is a normal answer, and callers run under pipefail.
  { grep -E '^[[:space:]]*NANOCLAW_UPDATE_CHANNEL[[:space:]]*=' "$1/.env" 2>/dev/null || true; } \
    | tail -1 | cut -d= -f2- | tr -d "\"'[:space:]" | tr 'A-Z' 'a-z'
}

# release_checkout_official_head <root> — true when HEAD is on a branch of the
# official repository (same URL rule as channels-remote.sh).
release_checkout_official_head() {
  local root=$1 remote url
  for remote in $(git -C "$root" remote 2>/dev/null); do
    url=$(git -C "$root" config --get "remote.$remote.url" 2>/dev/null || true)
    case "${url%.git}" in
      *[:/]qwibitai/nanoclaw|*[:/]nanocoai/nanoclaw)
        if [ -n "$(git -C "$root" for-each-ref --count=1 --contains HEAD "refs/remotes/$remote" 2>/dev/null)" ]; then
          return 0
        fi
        ;;
    esac
  done
  return 1
}

# release_checkout_decide <root> <requested-channel> <tty: 1|0>
#
# Prints one line:
#   none           leave the checkout alone and say nothing
#   offer <tag>    ask: latest release or newest code from main
#   switch <tag>   the channel was given explicitly, switch without asking
#   notice <tag>   no terminal, a fork, or a choice the release cannot save:
#                  keep the checkout, print a hint
#   invalid <raw>  the requested channel is not stable, beta or edge
release_checkout_decide() {
  local root=$1 requested tty=${3:-0} channel tag saved
  requested=$(printf '%s' "${2:-}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | tr 'A-Z' 'a-z')

  case "$requested" in
    ''|stable|beta|edge) ;;
    *) echo "invalid $requested"; return 0 ;;
  esac

  channel=${requested:-$(release_checkout_saved_channel "$root")}
  if [ "$channel" = edge ]; then echo none; return 0; fi

  # data/ holds the upgrade marker and the database: an existing install's
  # ref is the updater's to move, never setup's. The install id alone is
  # only a trace of an earlier launch that stopped before setup began.
  if [ -n "$(ls -A "$root/data" 2>/dev/null | grep -v '^install-id$')" ]; then echo none; return 0; fi

  [ "$(git -C "$root" rev-parse --show-toplevel 2>/dev/null)" = "$(cd "$root" && pwd -P)" ] || { echo none; return 0; }
  [ "$(git -C "$root" symbolic-ref --quiet --short HEAD 2>/dev/null)" = main ] || { echo none; return 0; }
  # Local edits or commits mean this is someone's working copy, not a fresh clone.
  [ -z "$(git -C "$root" status --porcelain --untracked-files=no 2>/dev/null)" ] || { echo none; return 0; }
  [ -n "$(git -C "$root" for-each-ref --count=1 --contains HEAD refs/remotes 2>/dev/null)" ] || { echo none; return 0; }

  # Annotated tags only, like the updater: the release workflow creates them.
  tag=$(git -C "$root" describe --abbrev=0 --match 'v[0-9]*' --exclude '*-*' HEAD 2>/dev/null) || { echo none; return 0; }
  printf '%s' "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || { echo none; return 0; }
  [ "$(git -C "$root" rev-list --count "$tag..HEAD" 2>/dev/null)" != 0 ] || { echo none; return 0; }

  if [ "$tty" != 1 ]; then echo "notice $tag"; return 0; fi
  # A fork's main may carry its owner's changes, which the release would drop.
  release_checkout_official_head "$root" || { echo "notice $tag"; return 0; }
  # A release from before this setting cannot save the choice, so only a
  # choice that is already in effect may switch to it.
  saved=$(release_checkout_saved_channel "$root")
  if [ -n "$requested" ] && [ "$requested" != "${saved:-stable}" ] \
    && ! git -C "$root" cat-file -e "$tag:setup/lib/release-checkout.sh" 2>/dev/null; then
    echo "notice $tag"; return 0
  fi
  if [ -n "$requested" ]; then echo "switch $tag"; return 0; fi
  echo "offer $tag"
}

# release_checkout_switch <root> <tag> — put the install on its own branch at the release.
release_checkout_switch() {
  git -C "$1" checkout --quiet -b stable "refs/tags/$2^{commit}" 2>/dev/null
}
