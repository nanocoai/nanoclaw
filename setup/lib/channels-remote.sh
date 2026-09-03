# channels-remote.sh — resolve the git remote that carries the `channels`
# branch. Source this file and call `resolve_channels_remote`; echoes the
# remote name (e.g. `origin` or `upstream`).
#
# Typical fork setups keep the upstream nanoclaw repo under a remote named
# `upstream`, with `origin` pointing at the user's fork. The channels branch
# only lives upstream, so a hardcoded `git fetch origin channels` fails for
# forks. This helper walks `git remote -v`, picks the remote whose URL points
# at nanocoai/nanoclaw, and prints its name.
#
# Fallback: if no existing remote matches, add `upstream` pointing at
# github.com/nanocoai/nanoclaw and return that — keeps forks without an
# explicit upstream configured working on the first try.
#
# Explicit override: set NANOCLAW_CHANNELS_REMOTE=<name> to skip detection.

resolve_channels_remote() {
  if [ -n "${NANOCLAW_CHANNELS_REMOTE:-}" ]; then
    printf '%s' "$NANOCLAW_CHANNELS_REMOTE"
    return 0
  fi

  # Anchor the repo-name tail: the pattern must match the nanoclaw repo itself,
  # never a sibling channel repo like qwibitai/nanoclaw-discord (which carries
  # no channels branch — an unanchored `*nanoclaw*` glob picked those on
  # multi-remote machines and broke every from-branch copy).
  local remote url
  while IFS=$'\t' read -r remote url; do
    case "$url" in
      *qwibitai/nanoclaw|*qwibitai/nanoclaw.git|*nanocoai/nanoclaw|*nanocoai/nanoclaw.git)
        printf '%s' "$remote"
        return 0
        ;;
    esac
  done < <(git remote -v 2>/dev/null | awk '$3 == "(fetch)" { print $1"\t"$2 }')

  # No matching remote — add `upstream` and use it. Silent on failure so
  # callers see the eventual `git fetch` error rather than a cryptic
  # remote-add failure.
  git remote add upstream https://github.com/nanocoai/nanoclaw.git 2>/dev/null || true
  printf '%s' "upstream"
}
