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
# Read as the updater reads it: trimmed, one pair of outer quotes removed, last
# non-empty assignment wins.
release_checkout_saved_channel() {
  [ -f "$1/.env" ] || return 0
  # `|| true`: no assignment is a normal answer, and callers run under pipefail.
  { grep -E '^[[:space:]]*NANOCLAW_UPDATE_CHANNEL[[:space:]]*=' "$1/.env" 2>/dev/null || true; } \
    | cut -d= -f2- \
    | sed -E -e 's/^[[:space:]]+|[[:space:]]+$//g' -e 's/^"(.*)"$/\1/' -e "s/^'(.*)'\$/\\1/" \
      -e 's/^[[:space:]]+|[[:space:]]+$//g' \
    | tr 'A-Z' 'a-z' | { grep -v '^$' || true; } | tail -1
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

# release_checkout_newest_tag <root> <stable|beta> — the tag the updater picks for
# that channel (scripts/update/channel.ts): annotated vX.Y.Z tags for stable; for
# beta also -beta.N and -rc.N, where a release sorts after its own pre-releases.
release_checkout_newest_tag() {
  { git -C "$1" for-each-ref --format='%(objecttype) %(refname:strip=2)' refs/tags 2>/dev/null || true; } \
    | awk -v channel="$2" '
        $1 != "tag" || $2 !~ /^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+|-beta\.[1-9][0-9]*)?$/ { next }
        {
          split(substr($2, 2), f, /[.-]/)
          stage = f[4] == "beta" ? 0 : f[4] == "rc" ? 1 : 2
          if (channel == "stable" && stage != 2) next
          print f[1] + 0, f[2] + 0, f[3] + 0, stage, f[5] + 0, $2
        }' \
    | sort -k1,1n -k2,2n -k3,3n -k4,4n -k5,5n | tail -1 | cut -d' ' -f6
}

# release_checkout_decide <root> <requested-channel> <tty: 1|0>
#
# Prints one line:
#   none                      leave the checkout alone and say nothing
#   offer <stable> <beta>     ask which channel; the newest tag of each
#   switch <channel> <tag>    the channel is known: install its release
#   notice <channel> <tag>    no terminal or a fork, and main is past the release:
#                             keep the checkout, print a hint
#   invalid <raw>             the requested channel is not stable, beta or edge
release_checkout_decide() {
  local root=$1 requested tty=${3:-0} channel stable beta tag
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

  stable=$(release_checkout_newest_tag "$root" stable)
  [ -n "$stable" ] || { echo none; return 0; }
  beta=$(release_checkout_newest_tag "$root" beta)
  tag=$stable
  if [ "$channel" = beta ]; then tag=$beta; fi

  # Without a terminal, or on a fork whose main may carry its owner's changes,
  # nothing moves; say so only when the first update would stop.
  if [ "$tty" != 1 ] || ! release_checkout_official_head "$root"; then
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

# release_checkout_answer <answer> — the channel for a number or name; anything else is stable.
release_checkout_answer() {
  case "$(printf '%s' "${1:-}" | tr -d '[:space:]' | tr 'A-Z' 'a-z')" in
    2|beta) echo beta ;;
    3|edge) echo edge ;;
    *) echo stable ;;
  esac
}

# release_checkout_save_channel <root> <channel> — NANOCLAW_UPDATE_CHANNEL into .env,
# as setup/set-env.ts writes it: the first assignment replaced, later ones dropped.
# The shell saves it because the release it switches to may predate this setting.
release_checkout_save_channel() {
  local env="$1/.env" next
  if [ ! -f "$env" ]; then
    # Private, like set-env.ts: later writes keep the mode, and setup stores secrets here.
    (umask 077 && printf 'NANOCLAW_UPDATE_CHANNEL=%s\n' "$2" > "$env")
    return 0
  fi
  next=$(awk -v line="NANOCLAW_UPDATE_CHANNEL=$2" '
    /^[[:space:]]*NANOCLAW_UPDATE_CHANNEL[[:space:]]*=/ { if (!done) print line; done = 1; next }
    { print }
    END { if (!done) print line }' "$env")
  # Redirect, not rename: keeps the file's mode and an operator's symlink.
  printf '%s\n' "$next" > "$env"
}

# release_checkout_switch <root> <channel> <tag> — put the install on a branch named
# after its channel, at the release. Git's own error stays visible: it names the
# cause, e.g. an existing branch of that name.
release_checkout_switch() {
  git -C "$1" checkout --quiet -b "$2" "refs/tags/$3^{commit}"
}
