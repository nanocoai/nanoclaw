#!/usr/bin/env bash
#
# migrate-v2-reset.sh — Wipe v2 migration state back to clean.
#
# For development iteration:
#   bash migrate-v2-reset.sh && bash migrate-v2.sh
#
# What it removes:
#   - data/                (v2 DBs, session state)
#   - logs/                (migration + setup logs)
#   - .env                 (merged env keys)
#   - groups/*/            (non-git group folders copied from v1)
#   - container/skills/*/  (untracked skill dirs copied from v1)
#   - src/channels/*.ts    (untracked adapters copied from channels branch)
#   - setup/groups.ts      (untracked, copied by channel install scripts)
#
# What it restores from git:
#   - groups/                       (CLAUDE.md files etc.)
#   - container/skills/             (tracked container skills)
#   - src/channels/                 (tracked bridge / registry code)
#   - setup/whatsapp-auth.ts        (channel installs may overwrite)
#   - setup/pair-telegram.ts        (channel installs may overwrite)
#   - setup/index.ts                (channel installs append entries)
#   - package.json + pnpm-lock.yaml (channel installs add deps)
#
# What it does NOT touch:
#   - node_modules/             (expensive to reinstall, kept on purpose)
#   - setup/migrate-v2/*        (the migration scripts themselves, plus user WIP)
#   - The v1 install            (read-only, never modified)

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

use_ansi() { [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; }
dim()   { use_ansi && printf '\033[2m%s\033[0m' "$1" || printf '%s' "$1"; }
green() { use_ansi && printf '\033[32m%s\033[0m' "$1" || printf '%s' "$1"; }

clean() {
  local target=$1 label=$2
  if [ -e "$target" ]; then
    rm -rf "$target"
    printf '%s  Removed %s\n' "$(green '✓')" "$label"
  fi
}

echo
printf '%s\n\n' "$(dim 'Resetting v2 migration state…')"

clean "data"  "data/"
clean "logs"  "logs/"
clean ".env"  ".env"

# Remove all group folders, then restore the two git-tracked ones
if [ -d "groups" ]; then
  rm -rf groups
  printf '%s  Removed %s\n' "$(green '✓')" "groups/"
fi
git checkout -- groups/ 2>/dev/null || true
printf '%s  Restored %s\n' "$(green '✓')" "groups/ from git"

# Restore container/skills/ to git state (remove v1-copied skills)
git checkout -- container/skills/ 2>/dev/null || true
# Remove any untracked skill dirs that were copied from v1
for d in container/skills/*/; do
  [ -d "$d" ] || continue
  if ! git ls-files --error-unmatch "$d" >/dev/null 2>&1; then
    rm -rf "$d"
  fi
done
printf '%s  Restored %s\n' "$(green '✓')" "container/skills/ from git"

# Restore channel code (src/channels/) to git state
git checkout -- src/channels/ 2>/dev/null || true
# Remove any untracked channel adapters copied in by install-*.sh
for f in src/channels/*.ts; do
  [ -f "$f" ] || continue
  if ! git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    rm -f "$f"
  fi
done
printf '%s  Restored %s\n' "$(green '✓')" "src/channels/ from git"

# Restore tracked setup helpers that channel installs overwrite, and
# remove the untracked ones they create. Don't blanket-clean setup/
# because user WIP (setup/migrate-v2/*) lives there too.
git checkout -- setup/whatsapp-auth.ts setup/pair-telegram.ts setup/index.ts 2>/dev/null || true
rm -f setup/groups.ts
printf '%s  Restored %s\n' "$(green '✓')" "setup/ install helpers"

# Restore package.json + lockfile (channel installs add deps like
# @whiskeysockets/baileys). node_modules/ is intentionally kept.
git checkout -- package.json pnpm-lock.yaml 2>/dev/null || true
printf '%s  Restored %s\n' "$(green '✓')" "package.json + pnpm-lock.yaml"

echo
printf '%s\n\n' "$(dim 'Clean. Run: bash migrate-v2.sh')"
