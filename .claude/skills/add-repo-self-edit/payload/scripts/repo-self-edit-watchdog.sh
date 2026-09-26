#!/usr/bin/env bash
# Repo self-edit watchdog — the host-restart half of an approved self-edit.
#
# Started detached by src/modules/repo-self-edit/checks.ts, because the host
# cannot restart itself and then judge the result. From here on nothing runs
# inside the host process:
#   1. Build the host (`pnpm run build`).
#   2. Restart the service and require a healthy host that is still the same
#      instance after a settle window (a crash loop changes the instance).
#   3. On any failure: commit the reverse of exactly the edit's files (never a
#      hard reset, and not `git revert`, which refuses while other work is
#      staged), rebuild, restart.
#   4. Write data/repo-self-edit-result.json; the host reports it to the
#      agent that proposed the edit.
#
# Usage: repo-self-edit-watchdog.sh <commit-sha> <session-id>
set -u

NEW_SHA="${1:?commit sha required}"
SESSION_ID="${2:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SETTLE_S="${REPO_SELF_EDIT_SETTLE_S:-20}"
cd "$ROOT" || exit 1
mkdir -p logs data
exec >>"$ROOT/logs/repo-self-edit-watchdog.log" 2>&1
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] watchdog: gating $NEW_SHA"

write_result() {
  # $1 ok (true|false)  $2 revert sha (may be empty)  $3 detail
  node -e '
    const [file, ok, sessionId, newSha, revertSha, detail] = process.argv.slice(1);
    require("fs").writeFileSync(file, JSON.stringify({ ok: ok === "true", sessionId, newSha, revertSha: revertSha || null, detail }));
  ' "$ROOT/data/repo-self-edit-result.json" "$1" "$SESSION_ID" "$NEW_SHA" "$2" "$3"
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] watchdog: ok=$1 revert=${2:-none} — $3"
}

stamp() {
  pnpm exec tsx scripts/upgrade-state.ts set "" "$1" >/dev/null 2>&1 || true
}

build() {
  local out rc
  out="$(pnpm run build 2>&1)"
  rc=$?
  printf '%s' "$out" | tail -n 40
  return $rc
}

instance() {
  node setup/lib/host-status.mjs snapshot "$ROOT" 2>/dev/null
}

restart_healthy() {
  bash setup/lib/restart.sh || return 1
  local before after
  before="$(instance)" || return 1
  sleep "$SETTLE_S"
  after="$(instance)" || return 1
  [ -n "$before" ] && [ "$before" = "$after" ]
}

# Paths are plain (no whitespace): the host refuses any other patch.
revert_edit() {
  local subject files
  subject="$(git log -1 --format=%s "$NEW_SHA")" || return 1
  files="$(git diff-tree --no-commit-id --name-only -r "$NEW_SHA")" || return 1
  git diff --binary "$NEW_SHA~1" "$NEW_SHA" | git apply -R --whitespace=nowarn - || return 1
  # shellcheck disable=SC2086
  if ! git add -- $files || ! git -c user.name='NanoClaw self-edit' -c user.email= \
    commit --no-verify -m "Revert \"$subject\"" -m "This reverts commit $NEW_SHA." -- $files; then
    # shellcheck disable=SC2086
    git reset -q -- $files
    git diff --binary "$NEW_SHA~1" "$NEW_SHA" | git apply --whitespace=nowarn -
    return 1
  fi
}

revert_and_recover() {
  local why="$1" out rev
  if ! out="$(revert_edit 2>&1)"; then
    write_result false "" "$why; reverting failed: $out"
    bash setup/lib/restart.sh || true
    exit 1
  fi
  rev="$(git rev-parse HEAD)"
  stamp repo-self-edit-revert
  if ! out="$(build)"; then
    write_result false "$rev" "$why; the reverted tree does not build either: $out"
    bash setup/lib/restart.sh || true
    exit 1
  fi
  if restart_healthy; then
    write_result false "$rev" "$why"
  else
    write_result false "$rev" "$why; the host did not come back healthy after the revert either"
  fi
  exit 1
}

if ! out="$(build)"; then
  revert_and_recover "host build failed: $out"
fi
if ! restart_healthy; then
  revert_and_recover "the host did not come back healthy after the restart"
fi
write_result true "" "healthy"
