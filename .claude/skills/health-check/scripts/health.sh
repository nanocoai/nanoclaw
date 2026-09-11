#!/usr/bin/env bash
# health.sh — one-call "is this NanoClaw install working?" check.
#
# Usage: [NANOCLAW_ROOT=<other checkout>] bash .claude/skills/health-check/scripts/health.sh [--chat]
#   --chat   also send "ping" through the CLI channel (needs a cli/local wiring)
#
# Read-only except for --chat, which sends one message to the wired agent.
# Everything is slug-scoped: this checkout's slug is sha1(<absolute checkout
# path>)[0:8] (src/install-slug.ts), so service label, image tag, and
# container label all differ per checkout. NANOCLAW_INSTALL_ID overrides it.
set -uo pipefail

ROOT="${NANOCLAW_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)}"
cd "$ROOT"
SLUG="${NANOCLAW_INSTALL_ID:-$(printf '%s' "$ROOT" | shasum | cut -c1-8)}"
LABEL="com.nanoclaw-v2-$SLUG"
UNIT="nanoclaw-v2-$SLUG"
IMAGE="nanoclaw-agent-v2-$SLUG:latest"
FAIL=0
ok()   { printf '  OK    %s\n' "$*"; }
warn() { printf '  WARN  %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; FAIL=1; }

echo "NanoClaw health — $ROOT (slug $SLUG)"

echo "1. Toolchain"
[ -d node_modules ] && ok "node_modules present" || bad "node_modules missing → pnpm install --frozen-lockfile"
[ -f .env ] && ok ".env present" || warn ".env missing (fine for a bare dev checkout; setup writes it)"

echo "2. Data"
[ -f data/v2.db ] && ok "data/v2.db present" || bad "data/v2.db missing → this checkout was never set up (pnpm run setup)"
if [ -d data/v2-sessions ]; then
  ok "$(find data/v2-sessions -mindepth 2 -maxdepth 2 -type d | wc -l | tr -d ' ') session dir(s)"
fi

echo "3. Service"
if [ "$(uname)" = Darwin ]; then
  if [ -f "$HOME/Library/LaunchAgents/$LABEL.plist" ]; then
    PID="$(launchctl list 2>/dev/null | awk -v l="$LABEL" '$3==l{print $1}')"
    case "$PID" in
      "")  warn "plist exists but $LABEL is not loaded → launchctl load ~/Library/LaunchAgents/$LABEL.plist";;
      -)   bad  "$LABEL loaded but not running → launchctl kickstart -k gui/$(id -u)/$LABEL; check logs/nanoclaw.error.log";;
      *)   ok   "$LABEL running (pid $PID)";;
    esac
  else
    warn "no launchd plist for this checkout → run with: pnpm run dev"
  fi
else
  if systemctl --user is-active --quiet "$UNIT" 2>/dev/null; then ok "$UNIT active"; else warn "$UNIT not active → systemctl --user start $UNIT (or pnpm run dev)"; fi
fi
N="$(pgrep -f "$ROOT/(dist/index.js|src/index.ts)" 2>/dev/null | wc -l | tr -d ' ')"
case "$N" in
  0) warn "no host process for this checkout";;
  1) ok "one host process";;
  *) bad "$N host processes for this checkout — one is stale, stop it";;
esac
[ -S data/ncl.sock ] && ok "ncl socket present" || warn "data/ncl.sock missing (host down, or never started here)"

echo "4. Containers"
if docker info >/dev/null 2>&1; then
  ok "docker daemon up"
  docker image inspect "$IMAGE" >/dev/null 2>&1 && ok "image $IMAGE" || bad "image $IMAGE missing → ./container/build.sh"
  RUNNING="$(docker ps --filter "label=nanoclaw-install=$SLUG" --format '{{.Names}} ({{.Status}})')"
  [ -n "$RUNNING" ] && ok "running: $(echo "$RUNNING" | tr '\n' ' ')" || ok "no containers running (normal when idle)"
else
  bad "docker daemon down → start Docker Desktop"
fi

echo "5. OneCLI gateway"
curl -fsS -m 3 http://127.0.0.1:10254/ >/dev/null 2>&1 && ok "gateway on 127.0.0.1:10254" || warn "gateway not answering on 127.0.0.1:10254 → onecli --help / /init-onecli"

echo "6. Recent errors (logs/nanoclaw.error.log)"
if [ -f logs/nanoclaw.error.log ]; then tail -n 5 logs/nanoclaw.error.log | sed 's/^/  | /'; else echo "  (no error log yet)"; fi

if [ "${1:-}" = "--chat" ]; then
  echo "7. End-to-end chat"
  if [ -S data/cli.sock ]; then
    pnpm run --silent chat "ping" 2>&1 | sed 's/^/  | /' || bad "chat failed"
  else
    bad "data/cli.sock missing → host down, or no cli/local wiring (/init-first-agent)"
  fi
fi

[ "$FAIL" = 0 ] && echo "RESULT: healthy" || { echo "RESULT: problems above"; exit 1; }
