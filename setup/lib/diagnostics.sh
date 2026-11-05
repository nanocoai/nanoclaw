# diagnostics.sh — shared PostHog emitter for bash-side setup code.
#
# Source this file after $PROJECT_ROOT is set:
#
#   source "$PROJECT_ROOT/setup/lib/diagnostics.sh"
#   ph_event bootstrap_completed status=success platform=macos
#
# All emits are fire-and-forget (background curl, 3s max timeout); they
# never fail the caller. Honors NANOCLAW_NO_DIAGNOSTICS=1. The distinct_id
# is persisted at data/install-id so the bash + node halves of setup use
# the same id and events from one install join into a single funnel.

NANOCLAW_PH_KEY='phc_fx1Hhx9ucz8GuaJC8LVZWO8u03yXZZJJ6ObS4yplnaP'
NANOCLAW_PH_URL='https://us.i.posthog.com/capture/'

# Resolve or create the persisted install id. Echoes the id (lowercase uuid).
# Creates data/install-id on first use. Safe to call pre-Node: uses only
# bash + uuidgen/urandom fallback + mkdir.
ph_install_id() {
  local root="${NANOCLAW_PROJECT_ROOT:-${PROJECT_ROOT:-$PWD}}"
  local f="$root/data/install-id"
  if [ ! -s "$f" ]; then
    mkdir -p "$(dirname "$f")" 2>/dev/null || return 0
    local id
    id=$(uuidgen 2>/dev/null \
      || cat /proc/sys/kernel/random/uuid 2>/dev/null \
      || printf 'fallback-%s-%s' "$(date +%s)" "$$")
    printf '%s' "$id" | tr 'A-Z' 'a-z' > "$f" 2>/dev/null || return 0
  fi
  cat "$f" 2>/dev/null
}

# Emit a PostHog event. First arg is the event name; remaining args are
# `key=value` pairs merged into properties. Values are JSON-escaped for
# quotes and backslashes; keep them short and alphanumeric-ish.
ph_event() {
  [ "${NANOCLAW_NO_DIAGNOSTICS:-}" = "1" ] && return 0
  local event=$1
  shift
  local id
  id=$(ph_install_id)
  [ -z "$id" ] && return 0

  local props='' first=1 kv k v
  for kv in "$@"; do
    k="${kv%%=*}"
    v="${kv#*=}"
    v=${v//\\/\\\\}
    v=${v//\"/\\\"}
    if [ "$first" = "1" ]; then first=0; else props+=','; fi
    props+="\"$k\":\"$v\""
  done

  local payload
  payload=$(printf '{"api_key":"%s","event":"%s","distinct_id":"%s","properties":{%s}}' \
    "$NANOCLAW_PH_KEY" "$event" "$id" "$props")

  curl -sS --max-time 3 -X POST "$NANOCLAW_PH_URL" \
    -H 'Content-Type: application/json' \
    -d "$payload" >/dev/null 2>&1 &
}
