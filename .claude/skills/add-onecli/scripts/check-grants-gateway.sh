#!/bin/sh
# Run by tool skills before they ask for or save a key: they attach the key with
# OneCLI agent grants. On a gateway without grants (before 1.44) a saved key
# reaches every agent; an agent still in `all` mode means the 1.44+ conversion
# has not finished and would receive it too. Prints the gateway version and
# exits 0 when the pinned gateway, every agent converted and a CLI with grants
# are in place; exits 1 otherwise. Reads only. Usage: check-grants-gateway.sh /<skill>
set -u
skill="${1:-this skill}"
# $2 names what needs fixing: cli (install or upgrade the CLI), config (point it
# at the gateway), reach (start the gateway), jq; otherwise the gateway version.
no() {
  case "${2:-}" in
    cli) need="the pinned onecli CLI, 2.11.0: see \"The CLI binary\" in docs/onecli-upgrades.md" ;;
    config) need="the onecli CLI pointed at and signed in to the OneCLI gateway: \`onecli config get api-host\` prints the address (set it with \`onecli config set api-host <ONECLI_URL from .env>\`), and a gateway with an API token needs \`grep '^ONECLI_API_KEY=' .env | cut -d= -f2- | tr -d '\"'\"'\" | onecli auth login >/dev/null 2>&1 && echo signed in || echo 'sign-in failed' >&2\`" ;;
    reach) need="a running OneCLI gateway at that address: start the OneCLI gateway, or fix the address with \`onecli config set api-host <ONECLI_URL from .env>\`" ;;
    jq) need="jq" ;;
    *) need="the pinned OneCLI gateway, 1.45: see docs/onecli-upgrades.md" ;;
  esac
  echo "$1. Nothing was written to OneCLI. $skill needs $need." >&2; exit 1
}
command -v onecli >/dev/null 2>&1 || no "the onecli CLI is not installed" cli
command -v jq >/dev/null 2>&1 || no "jq is not installed" jq
C=$(onecli config get api-host 2>/dev/null) || no "\`onecli config get api-host\` failed, so the OneCLI gateway cannot be checked" config
U=$(printf '%s' "$C" | jq -r '.value // empty' 2>/dev/null) \
  || no "could not read the api-host from \`onecli config get api-host\`, so the OneCLI gateway cannot be checked" config
[ -n "$U" ] || no "the onecli CLI has no api-host set, so the OneCLI gateway cannot be checked" config
H=$(curl -fsS --max-time 10 "$U/api/health" 2>/dev/null) || no "could not reach the OneCLI gateway at $U" reach
V=$(printf '%s' "$H" | jq -er '.version' 2>/dev/null) || V=
# Only a plain 1.45.N release passes: a pre-release or build suffix is refused.
case "$V" in
  1.45.*[!0-9]* | 1.45.) no "the OneCLI gateway at $U is $V, not a 1.45 release" ;;
  1.45.*) ;;
  1.44.*) no "the OneCLI gateway at $U is $V: it has agent grants but is not the pinned 1.45" ;;
  0.* | 1.[0-9].* | 1.[1-3][0-9].* | 1.4[0-3].*) no "the OneCLI gateway at $U is $V, older than 1.44 and has no agent grants" ;;
  1.4[6-9].* | 1.[5-9][0-9].* | 1.[1-9][0-9][0-9]*.* | [2-9].* | [1-9][0-9]*.*) no "the OneCLI gateway at $U is $V, newer than the pinned 1.45" ;;
  *) no "the OneCLI gateway at $U reports version '${V:-unreadable}', so it cannot be checked against the pinned 1.45" ;;
esac
AG=$(onecli agents list --max 0) || no "could not list OneCLI agents at $U" config
N=$(printf '%s' "$AG" | jq -er '[(if type == "array" then . else .data end)[] | select(.secretMode == "all")] | length') \
  || no "could not read the OneCLI agent list at $U"
[ "$N" = 0 ] || no "$N OneCLI agent(s) at $U are still in all mode: the gateway's grant conversion has not finished (run docs/onecli-upgrades.md's post-upgrade check)"
onecli agents grants --help >/dev/null 2>&1 \
  || no "the onecli CLI has no 'agents grants' command (it needs CLI 2.9 or later)" cli
echo "$V"
