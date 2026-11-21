#!/usr/bin/env bash
# bridge-account.sh [ENV_FILE] — print the Bridge account this checkout uses,
# by its primary address, or nothing when none is chosen (Bridge holds one).
#
# PROTON_BRIDGE_ACCOUNT from the environment wins; otherwise the last
# PROTON_BRIDGE_ACCOUNT= line of ENV_FILE (default .env), read as a .env value
# is: white space and a CR trimmed, a pair of matching quotes taken off, an
# inline comment after an unquoted value dropped.
# store-secrets.sh and the address step in SKILL.md both read it through this,
# so they always pick the same account (see bridge-secrets.sh).
set -euo pipefail
v=${PROTON_BRIDGE_ACCOUNT:-}
if [[ -z "$v" ]]; then
  v=$(grep -E '^[[:space:]]*PROTON_BRIDGE_ACCOUNT=' "${1:-.env}" 2>/dev/null | tail -n1 | cut -d= -f2-) || v=
fi
v=${v//$'\r'/}
v="${v#"${v%%[![:space:]]*}"}"
dq='^"([^"]*)"' sq="^'([^']*)'"
if [[ "$v" =~ $dq ]] || [[ "$v" =~ $sq ]]; then
  # A quoted value: what is inside the quotes (a comment may follow).
  v=${BASH_REMATCH[1]}
else
  # Unquoted: an inline comment (white space, then #) is not part of it,
  # nor is a comment standing where the value would be.
  [[ "$v" == \#* ]] && v=
  v=${v%%[[:space:]]#*}
  v="${v%"${v##*[![:space:]]}"}"
fi
printf '%s\n' "$v"
