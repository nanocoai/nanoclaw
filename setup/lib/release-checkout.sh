#!/usr/bin/env bash
#
# Release checkout: a new install picks its update channel before setup runs,
# and starts on that channel's code.
#
# A plain `git clone` lands on main, which is usually past the newest release,
# while updates follow releases by default. Left alone, the first update stops
# and asks which one the install follows. Sourced by nanoclaw.sh; needs only
# git and POSIX tools, since it runs before Node is installed.

# release_checkout_saved_channel <root> — NANOCLAW_UPDATE_CHANNEL from .env, if any.
# Read as the updater reads it: trimmed, one pair of outer quotes removed, the last
# assignment not empty at that point wins, and its value is trimmed again. A quoted
# blank therefore reads as empty here, where the updater rejects it.
release_checkout_saved_channel() {
  [ -f "$1/.env" ] || return 0
  # `|| true`: no assignment is a normal answer, and callers run under pipefail.
  { grep -E '^[[:space:]]*NANOCLAW_UPDATE_CHANNEL[[:space:]]*=' "$1/.env" 2>/dev/null || true; } \
    | cut -d= -f2- \
    | sed -E -e 's/^[[:space:]]+|[[:space:]]+$//g' -e "s/^\"(.*)\"\$|^'(.*)'\$/\\1\\2/" \
    | { grep -v '^$' || true; } | tail -1 \
    | sed -E 's/^[[:space:]]+|[[:space:]]+$//g' | tr 'A-Z' 'a-z'
}

# release_checkout_official_remote <root> — the remote of the official repository
# that has HEAD on one of its branches (same URL rule as channels-remote.sh), if any.
release_checkout_official_remote() {
  local root=$1 remote url
  for remote in $(git -C "$root" remote 2>/dev/null); do
    url=$(git -C "$root" config --get "remote.$remote.url" 2>/dev/null || true)
    case "${url%.git}" in
      *[:/]qwibitai/nanoclaw|*[:/]nanocoai/nanoclaw)
        if [ -n "$(git -C "$root" for-each-ref --count=1 --contains HEAD "refs/remotes/$remote" 2>/dev/null)" ]; then
          echo "$remote"
          return 0
        fi
        ;;
    esac
  done
}

# release_checkout_newest_tag <root> <stable|beta> [<remote>] — the tag the updater
# picks for that channel (scripts/update/channel.ts): annotated vX.Y.Z tags for
# stable; for beta also -beta.N and -rc.N, where a release sorts after its own
# pre-releases. With <remote>, only tags on that remote's branches count, so a
# tag fetched from anywhere else never decides what is installed.
release_checkout_newest_tag() {
  local root=$1 channel=$2 remote=${3:-} tag
  for tag in $(
    { git -C "$root" for-each-ref --format='%(objecttype) %(refname:strip=2)' refs/tags 2>/dev/null || true; } \
      | awk -v channel="$channel" '
          $1 != "tag" || $2 !~ /^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+|-beta\.[1-9][0-9]*)?$/ { next }
          {
            split(substr($2, 2), f, /[.-]/)
            stage = f[4] == "beta" ? 0 : f[4] == "rc" ? 1 : 2
            if (channel == "stable" && stage != 2) next
            print f[1] + 0, f[2] + 0, f[3] + 0, stage, f[5] + 0, $2
          }' \
      | sort -k1,1nr -k2,2nr -k3,3nr -k4,4nr -k5,5nr | cut -d' ' -f6
  ); do
    if [ -z "$remote" ] \
      || [ -n "$(git -C "$root" for-each-ref --count=1 --contains "refs/tags/$tag^{commit}" "refs/remotes/$remote" 2>/dev/null)" ]; then
      echo "$tag"
      return 0
    fi
  done
}

# release_checkout_decide <root> <requested-channel> <tty: 1|0>
#
# Prints one line:
#   none                      leave the checkout alone and say nothing
#   offer <stable> <beta>     ask which channel; the newest tag of each
#   switch <channel> <tag>    the channel is known (flag, env or .env): install its release
#   notice <channel> <tag>    no channel and no terminal, or a fork, and main is past
#                             the release: keep the checkout, print a hint
#   shallow                   a shallow clone without the channel's release tags:
#                             keep the checkout, print a hint
#   invalid <raw>             the requested channel is not stable, beta or edge
release_checkout_decide() {
  local root=$1 requested tty=${3:-0} channel remote stable beta tag
  requested=$(printf '%s' "${2:-}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | tr 'A-Z' 'a-z')

  case "$requested" in
    ''|stable|beta|edge) ;;
    *) echo "invalid $requested"; return 0 ;;
  esac

  channel=${requested:-$(release_checkout_saved_channel "$root")}
  if [ "$channel" = edge ]; then echo none; return 0; fi
  # The updater stops on a saved value it does not know; asking replaces it.
  case "$channel" in stable|beta) ;; *) channel= ;; esac

  # data/ holds the upgrade marker and the database: an existing install's
  # ref is the updater's to move, never setup's. The install id alone is
  # only a trace of an earlier launch that stopped before setup began.
  if [ -n "$(ls -A "$root/data" 2>/dev/null | grep -v '^install-id$')" ]; then echo none; return 0; fi

  [ "$(git -C "$root" rev-parse --show-toplevel 2>/dev/null)" = "$(cd "$root" && pwd -P)" ] || { echo none; return 0; }
  [ "$(git -C "$root" symbolic-ref --quiet --short HEAD 2>/dev/null)" = main ] || { echo none; return 0; }
  # Local edits or commits mean this is someone's working copy, not a fresh clone.
  [ -z "$(git -C "$root" status --porcelain --untracked-files=no 2>/dev/null)" ] || { echo none; return 0; }
  [ -n "$(git -C "$root" for-each-ref --count=1 --contains HEAD refs/remotes 2>/dev/null)" ] || { echo none; return 0; }

  remote=$(release_checkout_official_remote "$root")
  stable=$(release_checkout_newest_tag "$root" stable "$remote")
  beta=$(release_checkout_newest_tag "$root" beta "$remote")
  tag=$stable
  if [ "$channel" = beta ]; then tag=$beta; fi
  if [ -z "$tag" ]; then
    # `git clone --depth 1` fetches no tags, so there is no release to offer or compare with.
    if [ "$(git -C "$root" rev-parse --is-shallow-repository 2>/dev/null)" = true ]; then echo shallow; else echo none; fi
    return 0
  fi

  # A fork's main may carry its owner's changes, which a release would drop; with
  # no channel and no terminal there is no one to ask. Either way nothing moves,
  # and the hint shows only when the first update would stop.
  if [ -z "$remote" ] || { [ -z "$channel" ] && [ "$tty" != 1 ]; }; then
    if git -C "$root" merge-base --is-ancestor HEAD "refs/tags/$tag^{commit}" 2>/dev/null; then
      echo none
    else
      echo "notice ${channel:-stable} $tag"
    fi
    return 0
  fi
  if [ -z "$channel" ]; then echo "offer $stable $beta"; return 0; fi
  if [ "$(git -C "$root" rev-parse HEAD)" = "$(git -C "$root" rev-parse "refs/tags/$tag^{commit}")" ]; then
    echo none; return 0
  fi
  echo "switch $channel $tag"
}

# release_checkout_menu <stable-tag> <beta-tag> — the question nanoclaw.sh asks.
release_checkout_menu() {
  local beta_note=""
  if [ "$2" = "$1" ]; then beta_note=" (no newer one yet)"; fi
  echo ""
  echo "  Which updates should this install follow?"
  echo ""
  echo "  1) stable  published releases, now $1 (recommended)"
  echo "  2) beta    release candidates too, now $2$beta_note"
  echo "  3) edge    the newest code from main"
  echo ""
}

# release_checkout_answer <answer> — the channel for a number or name, stable for
# an empty answer, nothing for anything else (the caller asks again).
release_checkout_answer() {
  case "$(printf '%s' "${1:-}" | tr -d '[:space:]' | tr 'A-Z' 'a-z')" in
    ''|1|stable) echo stable ;;
    2|beta) echo beta ;;
    3|edge) echo edge ;;
  esac
}

# release_checkout_save_channel <root> <channel> — make <channel> the saved
# NANOCLAW_UPDATE_CHANNEL; fails if .env cannot be written. The shell saves it
# because the release it switches to may predate this setting. Appended, never
# rewritten: every reader takes the last assignment, the rest of .env is never at
# risk, and setup's own writer later folds the lines into one.
release_checkout_save_channel() {
  local env="$1/.env" last
  # Private, like set-env.ts: later writes keep the mode, and setup stores secrets
  # here. No-clobber, so a .env that appears meanwhile is appended to instead.
  if [ ! -e "$env" ] && (umask 077 && set -C && printf 'NANOCLAW_UPDATE_CHANNEL=%s\n' "$2" > "$env") 2>/dev/null; then
    return 0
  fi
  # Unreadable: neither the saved value nor the last byte can be checked.
  [ -r "$env" ] || return 1
  if [ "$(release_checkout_saved_channel "$1")" = "$2" ]; then return 0; fi
  last=$(tail -c 1 "$env") || return 1
  # Private too, should .env vanish meanwhile and be created by the append.
  (
    umask 077
    {
      if [ -n "$last" ]; then echo; fi
      printf 'NANOCLAW_UPDATE_CHANNEL=%s\n' "$2"
    } >> "$env"
  )
}

# release_checkout_switch <root> <channel> <tag> — put the install on a branch named
# after its channel, at the release. Git's own error stays visible: it names the
# cause, e.g. an existing branch of that name.
release_checkout_switch() {
  git -C "$1" checkout --quiet -b "$2" "refs/tags/$3^{commit}"
}
