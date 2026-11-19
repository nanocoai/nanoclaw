#!/usr/bin/env bash
#
# Update channel: a new install follows the channel of the branch it was cloned from.
#
# The official repository publishes `stable` and `beta` branches next to `main`;
# the release workflow moves them to each release. Cloning one is the choice
# (`git clone --branch stable`), so setup never moves the checkout: it records
# the matching channel for the updater. Sourced by nanoclaw.sh; needs only git
# and POSIX tools, since it runs before Node is installed.

# update_channel_saved <root> — NANOCLAW_UPDATE_CHANNEL from .env, if any.
# Read as the updater reads it: trimmed, one pair of outer quotes removed, the last
# assignment not empty at that point wins, and its value is trimmed again. A quoted
# blank therefore reads as empty here, where the updater rejects it.
update_channel_saved() {
  [ -f "$1/.env" ] || return 0
  # `|| true`: no assignment is a normal answer, and callers run under pipefail.
  { grep -E '^[[:space:]]*NANOCLAW_UPDATE_CHANNEL[[:space:]]*=' "$1/.env" 2>/dev/null || true; } \
    | cut -d= -f2- \
    | sed -E -e 's/^[[:space:]]+|[[:space:]]+$//g' -e "s/^\"(.*)\"\$|^'(.*)'\$/\\1\\2/" \
    | { grep -v '^$' || true; } | tail -1 \
    | sed -E 's/^[[:space:]]+|[[:space:]]+$//g' | tr 'A-Z' 'a-z'
}

# update_channel_official_branch <root> <branch> — true when HEAD is on <branch> of
# the official repository (same URL rule as channels-remote.sh). A fork's branches
# are its owner's, and a local branch that only shares the name says nothing.
update_channel_official_branch() {
  local root=$1 branch=$2 remote url
  for remote in $(git -C "$root" remote 2>/dev/null); do
    url=$(git -C "$root" config --get "remote.$remote.url" 2>/dev/null || true)
    case "${url%.git}" in
      *[:/]qwibitai/nanoclaw|*[:/]nanocoai/nanoclaw)
        if [ -n "$(git -C "$root" for-each-ref --count=1 --contains HEAD "refs/remotes/$remote/$branch" 2>/dev/null)" ]; then
          return 0
        fi
        ;;
    esac
  done
  return 1
}

# update_channel_decide <root> <requested-channel>
#
# Prints one line:
#   none              say nothing and record nothing
#   record <channel>  no channel chosen yet: the cloned branch names it
#                     (stable, beta, or main for edge)
#   ahead <channel>   stable or beta was chosen, but this copy is main past that
#                     channel's releases: print a hint
#   invalid <raw>     the requested channel is not stable, beta or edge
update_channel_decide() {
  local root=$1 requested channel branch
  requested=$(printf '%s' "${2:-}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | tr 'A-Z' 'a-z')

  case "$requested" in
    ''|stable|beta|edge) ;;
    *) echo "invalid $requested"; return 0 ;;
  esac

  channel=${requested:-$(update_channel_saved "$root")}
  # The updater stops on a saved value it does not know; recording replaces it.
  case "$channel" in stable|beta|edge) ;; *) channel= ;; esac

  # data/ holds the upgrade marker and the database: an existing install keeps
  # the channel it has. The install id alone is only a trace of an earlier
  # launch that stopped before setup began.
  if [ -n "$(ls -A "$root/data" 2>/dev/null | grep -v '^install-id$')" ]; then echo none; return 0; fi

  [ "$(git -C "$root" rev-parse --show-toplevel 2>/dev/null)" = "$(cd "$root" && pwd -P)" ] || { echo none; return 0; }
  branch=$(git -C "$root" symbolic-ref --quiet --short HEAD 2>/dev/null) || { echo none; return 0; }
  case "$branch" in stable|beta|main) ;; *) echo none; return 0 ;; esac
  update_channel_official_branch "$root" "$branch" || { echo none; return 0; }

  if [ -z "$channel" ]; then
    if [ "$branch" = main ]; then echo "record edge"; else echo "record $branch"; fi
    return 0
  fi

  # main is past a channel's releases unless it sits exactly on one: a release
  # for stable, a release or a pre-release for beta. Annotated tags only, like
  # the updater.
  if [ "$branch" = main ] && [ "$channel" != edge ]; then
    if [ "$channel" = stable ]; then
      git -C "$root" describe --exact-match --match 'v[0-9]*' --exclude '*-*' HEAD >/dev/null 2>&1 || { echo "ahead stable"; return 0; }
    else
      git -C "$root" describe --exact-match --match 'v[0-9]*' HEAD >/dev/null 2>&1 || { echo "ahead beta"; return 0; }
    fi
  fi
  echo none
}
