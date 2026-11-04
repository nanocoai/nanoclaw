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

# Lowercase uuid from uuidgen, the kernel, or a time+pid fallback.
ph_uuid() {
  { uuidgen 2>/dev/null \
    || cat /proc/sys/kernel/random/uuid 2>/dev/null \
    || printf 'fallback-%s-%s' "$(date +%s)" "$$"; } | tr -d '\n' | tr 'A-Z' 'a-z'
}

# One id per setup run. Exported so setup.sh and setup:auto (diagnostics.ts
# reads the same variable) tag their events with it.
if [ -z "${NANOCLAW_SETUP_RUN_ID:-}" ]; then
  NANOCLAW_SETUP_RUN_ID=$(ph_uuid)
  export NANOCLAW_SETUP_RUN_ID
fi

# Resolve or create the persisted install id. Echoes the id (lowercase uuid).
# Creates data/install-id on first use. Safe to call pre-Node: uses only
# bash + uuidgen/urandom fallback + mkdir.
ph_install_id() {
  local root="${NANOCLAW_PROJECT_ROOT:-${PROJECT_ROOT:-$PWD}}"
  local f="$root/data/install-id"
  if [ ! -s "$f" ]; then
    mkdir -p "$(dirname "$f")" 2>/dev/null || return 0
    ph_uuid > "$f" 2>/dev/null || return 0
  fi
  cat "$f" 2>/dev/null
}

# The fields every event carries, as key=value lines; commonProps() in
# diagnostics.ts sends the same set (arch uses Node's names).
ph_common_props() {
  local root="${NANOCLAW_PROJECT_ROOT:-${PROJECT_ROOT:-$PWD}}"
  local arch version channel
  arch=$(uname -m 2>/dev/null | tr 'A-Z' 'a-z')
  case "$arch" in
    x86_64 | amd64) arch=x64 ;;
    aarch64) arch=arm64 ;;
  esac
  version=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    "$root/package.json" 2>/dev/null | head -1)
  # Same rule as scripts/update/channel.ts: the env var, else the last
  # non-empty NANOCLAW_UPDATE_CHANNEL in .env, else stable.
  channel=${NANOCLAW_UPDATE_CHANNEL:-$(grep -E '^[[:space:]]*NANOCLAW_UPDATE_CHANNEL[[:space:]]*=' "$root/.env" 2>/dev/null \
    | sed 's/^[^=]*=//' | tr -d "\"' \t\r" | sed '/^$/d' | tail -1)}
  channel=$(printf '%s' "${channel:-stable}" | tr 'A-Z' 'a-z')
  case "$channel" in
    stable | beta | edge) ;;
    *) channel=unknown ;;
  esac
  printf 'arch=%s\nnanoclaw_version=%s\nrelease_channel=%s\nrun_id=%s\n' \
    "${arch:-unknown}" "${version:-unknown}" "$channel" "${NANOCLAW_SETUP_RUN_ID:-unknown}"
}

# Append one key=value pair to the calling ph_event's $props as JSON.
_ph_add_prop() {
  local k="${1%%=*}" v="${1#*=}"
  v=${v//\\/\\\\}
  v=${v//\"/\\\"}
  props+="${props:+,}\"$k\":\"$v\""
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

  local props='' kv
  for kv in "$@"; do
    _ph_add_prop "$kv"
  done
  while IFS= read -r kv; do
    [ -z "$kv" ] || _ph_add_prop "$kv"
  done <<EOF
$(ph_common_props)
EOF

  local payload
  payload=$(printf '{"api_key":"%s","event":"%s","distinct_id":"%s","properties":{%s}}' \
    "$NANOCLAW_PH_KEY" "$event" "$id" "$props")

  curl -sS --max-time 3 -X POST "$NANOCLAW_PH_URL" \
    -H 'Content-Type: application/json' \
    -d "$payload" >/dev/null 2>&1 &
}
