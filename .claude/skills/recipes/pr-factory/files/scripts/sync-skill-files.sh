#!/usr/bin/env bash
#
# sync-skill-files.sh — generate (or check) a skill's files/ mirror from the
# canonical in-tree files.
#
# Each skill that owns code lists its files in its skill folder's files.txt
# (one repo-relative path per line; blank lines and #-comments ignored).
# Skill folders live at any of three layers:
#
#   .claude/skills/<name>/                          (top-level skills)
#   .claude/skills/recipes/<recipe>/                (a recipe's own files)
#   .claude/skills/recipes/<recipe>/skills/<name>/  (recipe components)
#
# The canonical copy is the in-tree file; this script copies each listed path
# into <skill-folder>/files/<repo-relative-path> so the skill folder carries
# a generated mirror, never a hand-maintained duplicate.
#
# Usage:
#   scripts/sync-skill-files.sh <skill-path> [--check]
#   scripts/sync-skill-files.sh --all [--check]
#
# <skill-path> is relative to .claude/skills/ — e.g. `add-foo`,
# `recipes/pr-factory`, or `recipes/pr-factory/skills/slack-bots`.
#
# --check: byte-compare instead of copy; exit 1 listing drifted or missing
#          mirror files.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILLS_DIR="$REPO_ROOT/.claude/skills"

usage() {
  echo "Usage: $0 <skill-path>|--all [--check]" >&2
  exit 2
}

[ $# -ge 1 ] || usage

TARGET="$1"
shift
CHECK=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    *) usage ;;
  esac
done

sync_skill() {
  local name="$1"
  local manifest="$SKILLS_DIR/$name/files.txt"
  local mirror_root="$SKILLS_DIR/$name/files"
  local failed=0

  if [ ! -f "$manifest" ]; then
    echo "error: $manifest not found" >&2
    return 1
  fi

  while IFS= read -r line || [ -n "$line" ]; do
    # Strip comments and surrounding whitespace; skip blank lines.
    line="${line%%#*}"
    line="$(echo "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [ -n "$line" ] || continue

    local src="$REPO_ROOT/$line"
    local dst="$mirror_root/$line"

    if [ ! -f "$src" ]; then
      echo "[$name] MISSING in tree: $line" >&2
      failed=1
      continue
    fi

    if [ "$CHECK" -eq 1 ]; then
      if [ ! -f "$dst" ]; then
        echo "[$name] MISSING mirror: $line" >&2
        failed=1
      elif ! cmp -s "$src" "$dst"; then
        echo "[$name] DRIFTED: $line" >&2
        failed=1
      fi
    else
      mkdir -p "$(dirname "$dst")"
      cp "$src" "$dst"
      echo "[$name] synced: $line"
    fi
  done < "$manifest"

  return "$failed"
}

if [ "$TARGET" = "--all" ]; then
  status=0
  found=0
  for manifest in "$SKILLS_DIR"/*/files.txt "$SKILLS_DIR"/recipes/*/files.txt "$SKILLS_DIR"/recipes/*/skills/*/files.txt; do
    [ -f "$manifest" ] || continue
    found=1
    dir="${manifest%/files.txt}"
    name="${dir#"$SKILLS_DIR"/}"
    sync_skill "$name" || status=1
  done
  if [ "$found" -eq 0 ]; then
    echo "No skill manifests (files.txt at either skill layer) found — nothing to sync."
  fi
  exit "$status"
fi

sync_skill "$TARGET"
